import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TMP_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-sec5-')));
const BIN_PATH = fileURLToPath(new URL('../bin/causyne.js', import.meta.url));

const {
  createSession,
  deleteSession,
  listSessions,
  resolveSession,
  saveSessionMessages,
  sessionTranscriptFile,
  pruneEmptyOrphanSessions,
  ORPHAN_EMPTY_SESSION_TTL_MS
} = await import('../src/sessionJournal.js');

const {
  parseOutputFormat,
  parsePermissionMode,
  parseMaxTurns,
  composeHeadlessPrompt,
  readBoundedStdin,
  runHeadlessTask
} = await import('../src/headlessCli.js');

const {
  applyProviderOverrides,
  resolveProviderApiKey
} = await import('../src/config.js');

const createdSessions: string[] = [];

after(() => {
  for (const id of createdSessions) {
    try { deleteSession(id); } catch {}
  }
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {}
});

function ageSessionFile(id: string, targetTimestamp: number): void {
  const file = sessionTranscriptFile(id);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
    .map(line => {
      const parsed = JSON.parse(line);
      parsed.at = targetTimestamp;
      if (parsed.session && typeof parsed.session.createdAt === 'number') {
        parsed.session.createdAt = targetTimestamp;
      }
      return JSON.stringify(parsed);
    });
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

describe('Sector 5 — Abandoned 0-message orphan session pruning', () => {
  test('pruneEmptyOrphanSessions deletes aged 0-message orphans while preserving real history, active, and recent empty sessions', () => {
    const ws = path.join(TMP_ROOT, 'ws-orphan');
    const oldTs = Date.now() - ORPHAN_EMPTY_SESSION_TTL_MS - 60_000;

    // 1. Aged 0-message orphan -> MUST be pruned
    const staleEmpty = createSession(ws, 'Untitled', false);
    createdSessions.push(staleEmpty.id);
    ageSessionFile(staleEmpty.id, oldTs);

    // 2. Aged session WITH 1 real message -> MUST NEVER be pruned
    const staleReal = createSession(ws, 'Keep real conversation', false);
    createdSessions.push(staleReal.id);
    saveSessionMessages(staleReal.id, [{ role: 'user', content: 'Keep this forever' }]);
    ageSessionFile(staleReal.id, oldTs - 30 * 24 * 60 * 60 * 1000);

    // 3. Recent 0-message session -> MUST NOT be pruned yet
    const freshEmpty = createSession(ws, 'Untitled', false);
    createdSessions.push(freshEmpty.id);

    // 4. Aged 0-message session that is currently active -> MUST NOT be pruned
    const activeEmpty = createSession(ws, 'Untitled', true);
    createdSessions.push(activeEmpty.id);
    ageSessionFile(activeEmpty.id, oldTs);

    const removed = pruneEmptyOrphanSessions();
    assert.ok(removed >= 1, `Expected at least 1 orphan removed, got ${removed}`);

    const remainingIds = new Set(listSessions().map(s => s.id));
    assert.equal(remainingIds.has(staleEmpty.id), false, 'aged 0-message orphan must be pruned');
    assert.equal(remainingIds.has(staleReal.id), true, 'aged session with messages must never be pruned');
    assert.equal(remainingIds.has(freshEmpty.id), true, 'recent empty session must be preserved');
    assert.equal(remainingIds.has(activeEmpty.id), true, 'active session must be preserved');
  });

  test('resolveSession automatically cleans up aged 0-message orphans in background housekeeping', () => {
    const ws = path.join(TMP_ROOT, 'ws-auto-prune');
    const orphan = createSession(ws, 'Untitled', false);
    createdSessions.push(orphan.id);
    ageSessionFile(orphan.id, Date.now() - ORPHAN_EMPTY_SESSION_TTL_MS - 120_000);

    const active = resolveSession(path.join(TMP_ROOT, 'ws-other'));
    createdSessions.push(active.id);

    const remainingIds = new Set(listSessions().map(s => s.id));
    assert.equal(remainingIds.has(orphan.id), false, 'resolveSession should prune aged 0-message orphans');
  });
});

describe('Sector 5 — Headless / CI CLI options, stdin piping, and structured output formats', () => {
  test('option parsers accept valid formats/modes/turns and reject invalid inputs', () => {
    assert.equal(parseOutputFormat(undefined), 'text');
    assert.equal(parseOutputFormat('text'), 'text');
    assert.equal(parseOutputFormat('json'), 'json');
    assert.equal(parseOutputFormat('stream-json'), 'stream-json');
    assert.throws(() => parseOutputFormat('xml'), /Invalid --output-format/);

    assert.equal(parsePermissionMode(undefined), undefined);
    assert.equal(parsePermissionMode('a'), 'A');
    assert.equal(parsePermissionMode('balanced'), 'B');
    assert.equal(parsePermissionMode('autonomous'), 'C');
    assert.throws(() => parsePermissionMode('root'), /Invalid --permission-mode/);

    assert.equal(parseMaxTurns(undefined), undefined);
    assert.equal(parseMaxTurns('12'), 12);
    assert.throws(() => parseMaxTurns('0'), /Invalid --max-turns/);
    assert.throws(() => parseMaxTurns('9999'), /Invalid --max-turns/);
  });

  test('composeHeadlessPrompt handles prompt-only, stdin-only, dash placeholder, and combined inputs', () => {
    assert.equal(composeHeadlessPrompt('Explain this', ''), 'Explain this');
    assert.equal(composeHeadlessPrompt(true, 'piped task'), 'piped task');
    assert.equal(composeHeadlessPrompt('-', 'piped task'), 'piped task');
    assert.equal(composeHeadlessPrompt('Review this diff', '+const x = 1;'), 'Review this diff\n\n<stdin>\n+const x = 1;\n</stdin>');
    assert.equal(composeHeadlessPrompt('', '   '), '');
  });

  test('readBoundedStdin reads piped streams and truncates cleanly at maxBytes', async () => {
    const stream = new PassThrough() as PassThrough & { isTTY?: boolean };
    stream.isTTY = false;
    const promise = readBoundedStdin(stream, 16);
    stream.write('0123456789');
    stream.write('abcdefghij');
    stream.end();

    const text = await promise;
    assert.ok(text.startsWith('0123456789abcdef'));
    assert.match(text, /\[stdin truncated at 16 bytes\]/);
  });

  test('runHeadlessTask emits clean text, json, and stream-json outputs and applies per-run overrides', async () => {
    const capture = () => {
      let out = '';
      let err = '';
      return {
        stdout: { write: (s: string) => { out += s; } },
        stderr: { write: (s: string) => { err += s; } },
        getOut: () => out,
        getErr: () => err
      };
    };

    // 1. JSON format with streaming chunks, tool events, usage, and overrides
    const cJson = capture();
    let capturedOverrides: Record<string, unknown> = {};
    const prevExit = process.exitCode;
    try {
      const resJson = await runHeadlessTask('Audit file', {
        outputFormat: 'json',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        maxTurns: 7,
        permissionMode: 'B',
        stdout: cJson.stdout,
        stderr: cJson.stderr,
        loopFactory: (sink) => {
          const fakeLoop = {
            config: { provider: 'openai', model: 'gpt-4o' },
            memoryManager: { sessionId: 's_mock_1' },
            stepsCompleted: 2,
            _causyneTaskOutcome: 'completed',
            autonomyOverride: null as string | null,
            providerOverride: null as string | null,
            modelOverride: null as string | null,
            maxStepsCeiling: null as number | null,
            async run() {
              capturedOverrides = {
                autonomyOverride: this.autonomyOverride,
                providerOverride: this.providerOverride,
                modelOverride: this.modelOverride,
                maxStepsCeiling: this.maxStepsCeiling
              };
              sink.send(JSON.stringify({ type: 'step_start', tool: 'fs_read' }));
              sink.send(JSON.stringify({ type: 'step_complete', tool: 'fs_read' }));
              sink.send(JSON.stringify({ type: 'agent_message', content: 'All ', streaming: true }));
              sink.send(JSON.stringify({ type: 'agent_message', content: 'All clear.', streaming: true }));
              sink.send(JSON.stringify({ type: 'usage_update', inputTokens: 120, outputTokens: 30, totalTokens: 150 }));
            }
          };
          return fakeLoop;
        }
      });

      assert.equal(resJson.ok, true);
      assert.equal(process.exitCode, 0);
      assert.equal(cJson.getErr(), '');
      assert.deepEqual(capturedOverrides, {
        autonomyOverride: 'B',
        providerOverride: 'anthropic',
        modelOverride: 'claude-sonnet-4-6',
        maxStepsCeiling: 7
      });

      const parsed = JSON.parse(cJson.getOut());
      assert.equal(parsed.ok, true);
      assert.equal(parsed.status, 'completed');
      assert.equal(parsed.provider, 'anthropic');
      assert.equal(parsed.model, 'claude-sonnet-4-6');
      assert.equal(parsed.response, 'All clear.');
      assert.equal(parsed.toolCalls.length, 1);
      assert.deepEqual(parsed.toolCalls[0], { tool: 'fs_read', status: 'completed' });
      assert.equal(parsed.usage.totalTokens, 150);

      // 2. stream-json format emits NDJSON delta, tool_call, tool_result, result lines
      const cStream = capture();
      await runHeadlessTask('Stream check', {
        outputFormat: 'stream-json',
        stdout: cStream.stdout,
        stderr: cStream.stderr,
        loopFactory: (sink) => ({
          config: { provider: 'openai', model: 'gpt-4o' },
          memoryManager: { sessionId: 's_mock_2' },
          stepsCompleted: 1,
          _causyneTaskOutcome: 'completed',
          async run() {
            sink.send(JSON.stringify({ type: 'agent_message', content: 'Hel', streaming: true }));
            sink.send(JSON.stringify({ type: 'agent_message', content: 'Hello', streaming: true }));
          }
        })
      });

      const ndjson = cStream.getOut().trim().split('\n').map(line => JSON.parse(line));
      assert.equal(ndjson[0].type, 'start');
      assert.deepEqual(
        ndjson.filter(e => e.type === 'delta').map(e => e.text),
        ['Hel', 'lo']
      );
      assert.equal(ndjson.at(-1).type, 'result');
      assert.equal(ndjson.at(-1).response, 'Hello');

      // 3. text format on failure writes clean error to stderr and sets exitCode = 1
      const cText = capture();
      const resFail = await runHeadlessTask('Failing task', {
        outputFormat: 'text',
        stdout: cText.stdout,
        stderr: cText.stderr,
        loopFactory: (sink) => ({
          config: { provider: 'openai', model: 'gpt-4o' },
          stepsCompleted: 0,
          _causyneTaskOutcome: 'incomplete',
          async run() {
            sink.send(JSON.stringify({ type: 'error', message: 'Upstream 503' }));
          }
        })
      });
      assert.equal(resFail.ok, false);
      assert.equal(process.exitCode, 1);
      assert.match(cText.getErr(), /Upstream 503/);
    } finally {
      process.exitCode = prevExit;
    }
  });

  test('CLI entrypoint exposes headless flags, validates --output-format, and preserves unknown-subcommand errors', () => {
    const stateDir = path.join(TMP_ROOT, 'cli-state');
    const env = { ...process.env, CAUSYNE_HOME: stateDir };

    const help = execFileSync(process.execPath, [BIN_PATH, '--help'], { encoding: 'utf8', env });
    assert.match(help, /-p, --print/);
    assert.match(help, /--output-format/);
    assert.match(help, /--max-turns/);
    assert.match(help, /--permission-mode/);

    const badFormat = spawnSync(process.execPath, [BIN_PATH, '-p', 'hi', '--output-format', 'bogus'], {
      encoding: 'utf8',
      input: '',
      env
    });
    assert.equal(badFormat.status, 2);
    assert.match(badFormat.stderr, /Invalid --output-format/);

    const emptyPrompt = spawnSync(process.execPath, [BIN_PATH, '-p'], {
      encoding: 'utf8',
      input: '',
      env
    });
    assert.equal(emptyPrompt.status, 2);
    assert.match(emptyPrompt.stderr, /No prompt provided/);

    const badCmd = spawnSync(process.execPath, [BIN_PATH, 'definitely-not-a-command'], {
      encoding: 'utf8',
      input: '',
      env
    });
    assert.equal(badCmd.status, 1);
    assert.match(badCmd.stderr, /Invalid command/);
  });

  test('applyProviderOverrides hydrates vault providerKeys, prevents cross-provider key leakage, and clears foreign models', () => {
    // 1. Hydrates stored openrouter key when overriding from antigravity default
    const cfg1 = applyProviderOverrides(
      {
        provider: 'antigravity',
        model: 'Gemini 4 Neon (XHigh)',
        apiKey: '',
        providerKeys: { openrouter: 'sk-or-test-key' }
      },
      'openrouter',
      'openrouter/free'
    );
    assert.equal(cfg1.provider, 'openrouter');
    assert.equal(cfg1.apiKey, 'sk-or-test-key');
    assert.equal(cfg1.model, 'openrouter/free');

    // 2. Never leaks openai secret to anthropic when overriding to an unconfigured provider, and clears foreign model
    const cfg2 = applyProviderOverrides(
      {
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'sk-openai-secret',
        providerKeys: { openai: 'sk-openai-secret' }
      },
      'anthropic',
      null
    );
    assert.equal(cfg2.provider, 'anthropic');
    assert.equal(cfg2.apiKey, '');
    assert.equal(cfg2.model, '');

    // 3. Clears foreign model when switching to ACP peer without explicit --model
    const cfg3 = applyProviderOverrides(
      {
        provider: 'antigravity',
        model: 'Gemini 4 Neon (XHigh)',
        apiKey: '',
        providerKeys: {}
      },
      'opencode',
      undefined
    );
    assert.equal(cfg3.provider, 'opencode');
    assert.equal(cfg3.model, '');

    // 4. Resolves provider aliases safely and blocks prototype keys
    assert.equal(resolveProviderApiKey({ provider: 'x', providerKeys: { openrouter: 'sk-or-alias' } }, 'openrouter-free'), 'sk-or-alias');
    assert.equal(resolveProviderApiKey({ provider: 'x', providerKeys: { openrouter: 'sk-or-alias' } }, '__proto__'), '');
  });

  test('runHeadlessTask closes provider handles in finally and captures AgentLoop usage_update + peer nativeStep telemetry', async () => {
    let out = '';
    let closedCount = 0;
    const prevExit = process.exitCode;
    try {
      const res = await runHeadlessTask('Check peer telemetry', {
        outputFormat: 'json',
        provider: 'opencode',
        stdout: { write: (s: string) => { out += s; } },
        stderr: { write: () => {} },
        loopFactory: (sink) => ({
          config: { provider: 'opencode', model: '' },
          llm: {
            model: 'opencode/big-pickle',
            async close() {
              closedCount += 1;
            }
          },
          memoryManager: { sessionId: 's_peer_1' },
          stepsCompleted: 2,
          _causyneTaskOutcome: 'completed',
          async run() {
            sink.send(JSON.stringify({ type: 'notice', nativeStep: true, actionName: 'fs_read', message: 'opencode fs_read' }));
            sink.send(JSON.stringify({ type: 'warning', nativeStep: true, nativeFailed: true, actionName: 'sysRun', message: 'opencode could not sysRun' }));
            sink.send(JSON.stringify({ type: 'usage_update', taskTokens: 4200, cachedTokens: 3100, taskCostUsd: 0.012 }));
            sink.send(JSON.stringify({ type: 'agent_message', content: 'Done.', streaming: false }));
          }
        })
      });

      assert.equal(closedCount, 1, 'runHeadlessTask must close loop.llm on completion');
      assert.equal(res.ok, true);
      assert.equal(res.model, 'opencode/big-pickle');
      assert.deepEqual(res.toolCalls, [
        { tool: 'fs_read', status: 'completed' },
        { tool: 'sysRun', status: 'error', error: 'opencode could not sysRun' }
      ]);
      assert.deepEqual(res.usage, {
        totalTokens: 4200,
        cachedTokens: 3100,
        estimatedCostUsd: 0.012
      });
      const parsed = JSON.parse(out);
      assert.equal(parsed.model, 'opencode/big-pickle');
      assert.equal(parsed.usage.totalTokens, 4200);
    } finally {
      process.exitCode = prevExit;
    }
  });
});
