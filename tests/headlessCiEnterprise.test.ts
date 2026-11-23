import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runHeadlessTask } from '../src/headlessCli.js';
import { AgentLoop } from '../src/agentLoop.js';
import { loadConfig, saveConfig } from '../src/config.js';
import { createSession, getActiveSessionId } from '../src/sessionStore.js';
import { AuditLog } from '../src/auditLog.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const BIN_PATH = path.join(REPO_ROOT, 'bin', 'causyne.js');

function captureStdout(): { stream: { write(chunk: string): boolean }; read(): string } {
  let buf = '';
  return {
    stream: {
      write(chunk: string) {
        buf += String(chunk ?? '');
        return true;
      }
    },
    read: () => buf
  };
}

describe('Wave 6 — Headless CI Enterprise & Zero-Cost End-to-End Integration', () => {
  test('bin/causyne.js handles -C <dir>, --version, doctor, and audit verify cleanly with zero auto-update noise', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-ci-home-'));
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-ci-ws-'));
    try {
      const env = {
        ...process.env,
        CAUSYNE_HOME: tmpHome,
        OPENROUTER_API_KEY: 'test-ci-free-key'
      };

      const versionOut = execFileSync(process.execPath, [BIN_PATH, '-C', tmpWs, '--version'], {
        cwd: REPO_ROOT,
        env,
        encoding: 'utf8'
      }).trim();
      assert.match(versionOut, /^\d+\.\d+\.\d+/);

      const doctorOut = execFileSync(process.execPath, [BIN_PATH, '--cwd', tmpWs, 'doctor'], {
        cwd: REPO_ROOT,
        env: { ...env, CAUSYNE_DISABLE_AUTOUPDATE: '1' },
        encoding: 'utf8'
      });
      assert.match(doctorOut, /OS Sandbox/);
      assert.match(doctorOut, /Zero-Cost \$0/);
      assert.match(doctorOut, /openrouter-free/);

      const auditOut = execFileSync(process.execPath, [BIN_PATH, 'audit', 'verify'], {
        cwd: tmpWs,
        env,
        encoding: 'utf8'
      });
      assert.match(auditOut, /verified|0 error|No audit/i);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(tmpWs, { recursive: true, force: true });
    }
  });

  test('runHeadlessTask enforces --json-schema, stream-json events, and ephemeral session isolation in CI', async () => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-ci-headless-'));
    const prevExitCode = process.exitCode;
    try {
      const existing = createSession(tmpWs, 'Interactive user session');
      assert.equal(getActiveSessionId(), existing.id);

      const outJson = captureStdout();
      const schema = JSON.stringify({
        type: 'object',
        required: ['status', 'score'],
        properties: {
          status: { type: 'string' },
          score: { type: 'number' }
        }
      });

      const okLoopFactory = (sink: { send(raw: string): void }) => ({
        config: { provider: 'openrouter-free', model: 'openrouter/free' },
        stepsCompleted: 1,
        _causyneTaskOutcome: 'completed',
        async run() {
          sink.send(JSON.stringify({ type: 'usage_update', inputTokens: 120, outputTokens: 35, taskTokens: 155, taskCostUsd: 0 }));
          sink.send(JSON.stringify({ type: 'agent_message', content: '{"status":"pass","score":100}' }));
        }
      });

      await runHeadlessTask('Return structured CI verdict', {
        workspaceRoot: tmpWs,
        outputFormat: 'json',
        jsonSchema: schema,
        stdout: outJson.stream,
        loopFactory: okLoopFactory as any
      });
      const parsed = JSON.parse(outJson.read().trim());
      assert.equal(parsed.ok, true);
      assert.equal(parsed.structuredOutput?.status, 'pass');
      assert.equal(parsed.structuredOutput?.score, 100);
      assert.equal(parsed.usage?.inputTokens, 120);
      assert.equal(parsed.usage?.outputTokens, 35);
      assert.equal(getActiveSessionId(), existing.id, 'headless run must preserve parent active session');

      // Verify stream-json emits structured NDJSON frames and fails cleanly on schema mismatch
      const outStream = captureStdout();
      const badLoopFactory = (sink: { send(raw: string): void }) => ({
        config: { provider: 'openrouter-free', model: 'openrouter/free' },
        stepsCompleted: 1,
        _causyneTaskOutcome: 'completed',
        async run() {
          sink.send(JSON.stringify({ type: 'agent_message', content: '{"status":"pass"}' })); // missing required `score`
        }
      });

      await runHeadlessTask('Return incomplete schema', {
        workspaceRoot: tmpWs,
        outputFormat: 'stream-json',
        jsonSchema: schema,
        stdout: outStream.stream,
        loopFactory: badLoopFactory as any
      });
      const lines = outStream.read().trim().split('\n').map((l) => JSON.parse(l));
      const resultFrame = lines.find((frame) => frame.type === 'result');
      assert.ok(resultFrame, 'stream-json must emit terminal result frame');
      assert.equal(resultFrame.ok, false);
      assert.match(String(resultFrame.error || ''), /schema|score/i);
    } finally {
      process.exitCode = prevExitCode;
      fs.rmSync(tmpWs, { recursive: true, force: true });
    }
  });

  test('AgentLoop executes zero-cost failover from exhausted free cloud route to local Ollama route and logs audit event', async () => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-ci-failover-'));
    const prevConfig = loadConfig();
    try {
      saveConfig({
        ...prevConfig,
        provider: 'openrouter-free',
        model: 'openrouter/free',
        apiKey: 'test-or-free',
        zeroCostFailover: true
      });

      const events: Array<Record<string, unknown>> = [];
      const loop = new AgentLoop(
        {
          readyState: 1,
          send(raw: string) {
            try { events.push(JSON.parse(raw)); } catch { /* ignore */ }
          }
        },
        'ci-failover-1',
        'Reply with OK',
        { workspaceRoot: tmpWs, ephemeralSession: true }
      );
      loop.backoff = async () => {};

      let openrouterCalls = 0;
      let ollamaCalls = 0;
      const failingLlm = {
        model: 'openrouter/free',
        async chat() {
          openrouterCalls++;
          const err: any = new Error('HTTP 429: Free tier rate limit exceeded');
          err.status = 429;
          throw err;
        }
      };
      const localFallbackLlm = {
        model: 'qwen2.5-coder:7b',
        async chat() {
          ollamaCalls++;
          return {
            content: 'ZERO_COST_FAILOVER_SUCCESS',
            toolCalls: [],
            usage: { promptTokens: 40, completionTokens: 10, totalTokens: 50, source: 'provider_reported' }
          };
        }
      };

      loop.zeroCostFailoverCandidates = [
        {
          id: 'ollama',
          label: 'Ollama (Local Offline)',
          provider: 'ollama',
          model: 'qwen2.5-coder:7b',
          costTier: 'offline_free',
          readiness: 'ready',
          reason: 'Local Ollama reachable'
        }
      ];
      loop.initializeProvider = () => {
        const chosen = loop.config?.provider === 'ollama' ? localFallbackLlm : failingLlm;
        loop._factoryLlmRef = chosen;
        return chosen;
      };
      loop.llm = loop.initializeProvider();

      await loop.run();

      assert.equal(openrouterCalls, 5, 'should exhaust all 5 rate-limit retries before failing over');
      assert.equal(ollamaCalls, 1, 'should complete cleanly on local Ollama after zero-cost failover');
      assert.equal(loop.config.provider, 'ollama');
      assert.equal(loop.config.model, 'qwen2.5-coder:7b');
      assert.equal(loop.config.apiKey, '', 'old OpenRouter key must not carry over to Ollama');
      assert.ok(events.some((e) => e.type === 'notice' && /Zero-cost failover/.test(String(e.message || ''))));

      const audit = new AuditLog();
      const recent = audit.getRecentLogs(20);
      assert.ok(recent.some((entry) => entry.event === 'zero_cost_failover' && entry.toProvider === 'ollama'));
    } finally {
      saveConfig(prevConfig);
      fs.rmSync(tmpWs, { recursive: true, force: true });
    }
  });
});
