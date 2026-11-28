import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_PERSONALIZATION_BYTES,
  deleteCausyneMemories,
  isExternalToolAssistedToolName,
  readPersonalizationOverview,
  resolveEffectiveMemoryPolicy,
  saveMemoryPreferences,
  savePersonalizationInstructions
} from '../src/personalization.js';
import {
  formatProjectInstructionsPrompt,
  formatProjectRulesReport,
  loadProjectInstructions
} from '../src/projectInstructions.js';
import { addFact, getMemoryStats } from '../src/memory.js';
import { episodicStore } from '../src/memory/episodicStore.js';
import { memoryWrite } from '../src/tools/memoryWrite.js';
import { runCommand } from '../src/commands.js';
import { loadConfig, saveConfig } from '../src/config.js';
import { startSkybridgeServer } from '../src/web/skybridgeServer.js';
import { AgentLoop } from '../src/agentLoop.js';
import { AcpProvider } from '../src/providers/acp.js';
import { AntigravityProvider } from '../src/providers/antigravity.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-personalization-'));
const FAKE_HOME = path.join(TMP_ROOT, 'causyne-home');
fs.mkdirSync(FAKE_HOME, { recursive: true });

const PREV_CAUSYNE_HOME = process.env.CAUSYNE_HOME;
process.env.CAUSYNE_HOME = FAKE_HOME;

after(() => {
  if (PREV_CAUSYNE_HOME === undefined) delete process.env.CAUSYNE_HOME;
  else process.env.CAUSYNE_HOME = PREV_CAUSYNE_HOME;
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 40 });
  } catch { /* ignore */ }
});

describe('Per-Project Personalization, Memory Governance & Multi-Section Settings', () => {
  test('per-project personalization stays isolated per workspace and renders high-priority binding contract', () => {
    const projectA = path.join(TMP_ROOT, 'project-alpha');
    const projectB = path.join(TMP_ROOT, 'project-beta');
    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });

    savePersonalizationInstructions(projectA, 'global', 'Global baseline: prefer clean typed modules.');
    savePersonalizationInstructions(projectA, 'project', 'Alpha mandate: always prefix summaries with [ALPHA-SPEC].');

    const loadedA = loadProjectInstructions(projectA, { CAUSYNE_HOME: FAKE_HOME });
    const promptA = formatProjectInstructionsPrompt(loadedA);
    assert.equal(loadedA.entries.some((e) => e.scope === 'personalization'), true);
    assert.match(promptA, /PROJECT PERSONALIZATION & WORKSPACE INSTRUCTIONS — TREAT AS HIGH-PRIORITY BINDING CONTRACT/);
    assert.match(promptA, /Alpha mandate: always prefix summaries with \[ALPHA-SPEC\]/);
    assert.match(promptA, /Global baseline: prefer clean typed modules/);

    const loadedB = loadProjectInstructions(projectB, { CAUSYNE_HOME: FAKE_HOME });
    const promptB = formatProjectInstructionsPrompt(loadedB);
    assert.equal(loadedB.entries.some((e) => e.scope === 'personalization'), false);
    assert.doesNotMatch(promptB, /ALPHA-SPEC/);
    assert.match(promptB, /Global baseline: prefer clean typed modules/);

    const rulesReport = formatProjectRulesReport(projectA, { CAUSYNE_HOME: FAKE_HOME });
    assert.match(rulesReport, /\[personalization\]/);
  });

  test('SYSTEM_PROMPT retains core safety net and explicitly directs strict obedience to Project Personalization', () => {
    const loopSource = fs.readFileSync(path.join(process.cwd(), 'src', 'agentLoop.ts'), 'utf8');
    assert.match(loopSource, /# Personalization & Project Instructions \(HIGH-PRIORITY DIRECTIVE\)/);
    assert.match(loopSource, /Treat Project Personalization as a Big Deal/);
    assert.match(loopSource, /binding high-priority operational contract/);
    assert.match(loopSource, /# ABSOLUTE ETHICAL SAFETY NET \(NON-NEGOTIABLE\)/);
  });

  test('savePersonalizationInstructions refuses symlinks and oversized payloads', () => {
    const ws = path.join(TMP_ROOT, 'project-security');
    fs.mkdirSync(path.join(ws, '.causyne'), { recursive: true });

    assert.throws(
      () => savePersonalizationInstructions(ws, 'project', 'x'.repeat(MAX_PERSONALIZATION_BYTES + 1)),
      /exceed maximum size/
    );

    if (process.platform !== 'win32') {
      const outside = path.join(TMP_ROOT, 'outside-target.md');
      fs.writeFileSync(outside, 'DO_NOT_OVERWRITE', 'utf8');
      fs.symlinkSync(outside, path.join(ws, '.causyne', 'personalization.md'));
      assert.throws(
        () => savePersonalizationInstructions(ws, 'project', 'Should fail on symlink'),
        /Refusing symlink/
      );
      assert.equal(fs.readFileSync(outside, 'utf8'), 'DO_NOT_OVERWRITE');
    }
  });

  test('memory governance toggles block memory_write when disabled or tool-assisted polluted, and scoped deletion preserves other projects', async () => {
    const wsA = path.join(TMP_ROOT, 'mem-alpha');
    const wsB = path.join(TMP_ROOT, 'mem-beta');
    fs.mkdirSync(wsA, { recursive: true });
    fs.mkdirSync(wsB, { recursive: true });

    // Confirm external tool classification
    assert.equal(isExternalToolAssistedToolName('mcp__github__list_prs'), true);
    assert.equal(isExternalToolAssistedToolName('web_search'), true);
    assert.equal(isExternalToolAssistedToolName('browser_act'), true);
    assert.equal(isExternalToolAssistedToolName('fs_read'), false);

    // Default enabled -> writes succeed
    const okWrite = await memoryWrite.execute({ fact: 'Alpha uses pnpm workspaces' }, { workspaceRoot: wsA });
    assert.equal(okWrite.success, true);
    addFact('Beta uses Cargo workspace', { workspace: wsB });
    episodicStore.recordObservation({
      taskId: 't-alpha',
      workspace: wsA,
      type: 'decision',
      title: 'Alpha architecture note',
      narrative: 'Alpha uses strict TypeScript.',
      toolName: 'memory_write'
    });
    episodicStore.recordObservation({
      taskId: 't-beta',
      workspace: wsB,
      type: 'decision',
      title: 'Beta architecture note',
      narrative: 'Beta uses Rust.',
      toolName: 'memory_write'
    });

    // Disable memories for wsA only -> wsA blocked, wsB unaffected
    saveMemoryPreferences(wsA, 'project', { enabled: false });
    assert.equal(resolveEffectiveMemoryPolicy(wsA).enabled, false);
    assert.equal(resolveEffectiveMemoryPolicy(wsB).enabled, true);

    const blockedWrite = await memoryWrite.execute({ fact: 'Should not save while disabled' }, { workspaceRoot: wsA });
    assert.equal(blockedWrite.success, false);
    assert.match(blockedWrite.error || '', /disabled/i);

    // Re-enable memories, disable tool-assisted memories for wsA
    saveMemoryPreferences(wsA, 'project', { enabled: true, allowToolAssisted: false });
    const blockedPolluted = await memoryWrite.execute(
      { fact: 'Should not save from MCP/web chat' },
      {
        workspaceRoot: wsA,
        parentLoop: {
          workspaceRoot: wsA,
          isMemoryPollutedByExternalTools: () => true
        }
      }
    );
    assert.equal(blockedPolluted.success, false);
    assert.match(blockedPolluted.error || '', /tool-assisted/i);

    // Non-polluted chat still writes cleanly
    const cleanWrite = await memoryWrite.execute(
      { fact: 'Clean local fact for Alpha' },
      {
        workspaceRoot: wsA,
        parentLoop: {
          workspaceRoot: wsA,
          isMemoryPollutedByExternalTools: () => false
        }
      }
    );
    assert.equal(cleanWrite.success, true);

    // Project-scoped delete clears wsA without deleting wsB
    const delA = deleteCausyneMemories(wsA, 'project');
    assert.ok(delA.factsRemoved >= 1);
    assert.ok(delA.observationsRemoved >= 1);
    assert.equal(getMemoryStats(wsA).projectFacts, 0);
    assert.ok(getMemoryStats(wsB).projectFacts >= 1);
    assert.ok(episodicStore.getStats(wsB).projectObservations >= 1);

    // All-scope delete clears remaining memories
    deleteCausyneMemories(wsB, 'all');
    assert.equal(getMemoryStats(wsB).totalFacts, 0);
    assert.equal(episodicStore.getStats(wsB).totalObservations, 0);
  });

  test('CLI /personalization and /memory slash commands work end-to-end', async () => {
    const ws = path.join(TMP_ROOT, 'cli-project');
    fs.mkdirSync(ws, { recursive: true });
    const loopStub = { workspaceRoot: ws, staticContext: { stale: true } } as any;

    const setRes = await runCommand('personalization', ['set', 'Always', 'write', 'pure', 'functions'], { loop: loopStub });
    assert.equal(setRes.ok, true);
    assert.equal(loopStub.staticContext, null);

    const showRes = await runCommand('personalization', ['show'], { loop: loopStub });
    assert.equal(showRes.ok, true);
    assert.match(showRes.output || '', /Always write pure functions/);

    const memOff = await runCommand('memory', ['off'], { loop: loopStub });
    assert.equal(memOff.ok, true);
    assert.equal(resolveEffectiveMemoryPolicy(ws).enabled, false);

    const toolOff = await runCommand('memory', ['tool-assisted', 'off'], { loop: loopStub });
    assert.equal(toolOff.ok, true);
    assert.equal(resolveEffectiveMemoryPolicy(ws).allowToolAssisted, false);

    const clearRes = await runCommand('personalization', ['clear', 'project'], { loop: loopStub });
    assert.equal(clearRes.ok, true);
    assert.equal(readPersonalizationOverview(ws).project.exists, false);
  });

  test('Skybridge Settings Studio API serves all sections and persists personalization, configuration, memory & hook toggles', async () => {
    const ws = path.join(TMP_ROOT, 'skybridge-settings-ws');
    fs.mkdirSync(ws, { recursive: true });

    const cfg = loadConfig();
    cfg.hooks = [
      { name: 'lint-check', event: 'PostToolUse', tools: ['fs_write'], command: ['echo', 'ok'], enabled: true }
    ];
    saveConfig(cfg);

    const server = await startSkybridgeServer({ workspaceRoot: ws, port: 0 });
    try {
      const headers = {
        Authorization: `Bearer ${server.token}`,
        'Content-Type': 'application/json'
      };

      // HTML contains redesigned 9-section rail + preserved legacy IDs
      const htmlRes = await fetch(`${server.origin}/`);
      assert.equal(htmlRes.status, 200);
      const html = await htmlRes.text();
      for (const id of [
        'settings-nav-general',
        'settings-nav-configuration',
        'settings-nav-personalization',
        'settings-nav-billing',
        'settings-nav-vault',
        'settings-nav-mcp',
        'settings-nav-hooks',
        'settings-nav-plugins',
        'settings-nav-diagnostics',
        'personalization-instructions-input',
        'personalization-memory-enabled',
        'personalization-memory-tool-assisted',
        'personalization-memory-delete-btn',
        'settings-perm-select',
        'vault-save-btn',
        'doctor-load-btn',
        'license-upgrade-btn'
      ]) {
        assert.match(html, new RegExp(`id="${id}"`), `Missing expected Settings DOM id="${id}"`);
      }

      // GET /api/settings/overview
      const ovRes = await fetch(`${server.origin}/api/settings/overview`, { headers });
      assert.equal(ovRes.status, 200);
      const ov = await ovRes.json() as any;
      assert.equal(ov.ok, true);
      assert.equal(ov.general.workspaceName, 'skybridge-settings-ws');
      assert.equal(ov.hooks.length, 1);
      assert.equal(ov.hooks[0].enabled, true);

      // POST /api/settings/personalization (project scope)
      const savePRes = await fetch(`${server.origin}/api/settings/personalization`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          scope: 'project',
          instructions: 'Strict project contract: zero global mutable state.',
          memoryEnabled: true,
          allowToolAssisted: false
        })
      });
      assert.equal(savePRes.status, 200);
      const saveP = await savePRes.json() as any;
      assert.equal(saveP.personalization.project.exists, true);
      assert.match(saveP.personalization.project.content, /zero global mutable state/);
      assert.equal(saveP.personalization.memory.allowToolAssisted, false);

      // Oversized payload rejected cleanly with 400
      const bigRes = await fetch(`${server.origin}/api/settings/personalization`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ scope: 'project', instructions: 'a'.repeat(MAX_PERSONALIZATION_BYTES + 10) })
      });
      assert.equal(bigRes.status, 400);

      // POST /api/settings/configuration
      const cfgRes = await fetch(`${server.origin}/api/settings/configuration`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          osSandbox: 'strict',
          reasoningEffort: 'high',
          tokenBudget: { enabled: true, maxTokensPerTask: 200000, maxTokensPerDay: 2000000, maxCostUsd: 10, hardStop: true },
          autoCompact: { enabled: true, thresholdPercent: 80 }
        })
      });
      assert.equal(cfgRes.status, 200);
      const updatedCfg = await cfgRes.json() as any;
      assert.equal(updatedCfg.configuration.osSandbox.configuredMode, 'strict');
      assert.equal(updatedCfg.configuration.reasoningEffort, 'high');
      assert.equal(updatedCfg.configuration.tokenBudget.enabled, true);
      assert.equal(updatedCfg.configuration.tokenBudget.hardStop, true);
      assert.equal(updatedCfg.configuration.autoCompact.thresholdPercent, 80);

      // POST /api/settings/hooks/toggle
      const hookRes = await fetch(`${server.origin}/api/settings/hooks/toggle`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ index: 0, enabled: false })
      });
      assert.equal(hookRes.status, 200);
      const hookData = await hookRes.json() as any;
      assert.equal(hookData.hooks[0].enabled, false);

      // POST /api/settings/memories/delete
      addFact('Skybridge test fact', { workspace: ws });
      const delRes = await fetch(`${server.origin}/api/settings/memories/delete`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ scope: 'project' })
      });
      assert.equal(delRes.status, 200);
      const delData = await delRes.json() as any;
      assert.equal(delData.ok, true);
      assert.ok(delData.factsRemoved >= 1);
      assert.equal(delData.memoryStats.projectFacts, 0);
    } finally {
      await server.close();
    }
  });

  test('AgentLoop.buildStaticContext honors per-project personalization and memory toggle across providers', async () => {
    const ws = path.join(TMP_ROOT, 'agentloop-persona-ws');
    fs.mkdirSync(ws, { recursive: true });
    savePersonalizationInstructions(ws, 'project', 'MANDATE-42: Always verify strict TypeScript types.');
    episodicStore.recordObservation({
      taskId: 'obs-loop-1',
      workspace: ws,
      type: 'decision',
      title: 'Loop test memory note',
      narrative: 'Memory note that should hide when disabled.',
      toolName: 'memory_write'
    });

    const loop = new AgentLoop(null, 'task-persona-1', 'Check codebase', { workspaceRoot: ws });
    const ctxEnabled = await loop.buildStaticContext();
    assert.match(ctxEnabled.projectInstructions, /MANDATE-42: Always verify strict TypeScript types/);
    assert.match(ctxEnabled.projectInstructions, /TREAT AS HIGH-PRIORITY BINDING CONTRACT/);
    assert.match(ctxEnabled.episodicContext, /Loop test memory note/);

    // Turning memory OFF for this project hides episodic context immediately on next static context build
    saveMemoryPreferences(ws, 'project', { enabled: false });
    const ctxDisabled = await loop.buildStaticContext();
    assert.equal(ctxDisabled.episodicContext, '');
    assert.match(ctxDisabled.projectInstructions, /MANDATE-42: Always verify strict TypeScript types/);

    // Verify ACP and Antigravity providers preserve Language Directive and include Personalization Directive
    const acp = new AcpProvider({ provider: 'acp/opencode' });
    const acpConv = acp.formatConversation([{ role: 'user', content: 'hi' }]);
    assert.match(acpConv, /\[Personalization Directive\]/);
    assert.match(acpConv, /\[Language & Communication Directive\]/);

    const agy = new AntigravityProvider({ provider: 'antigravity' });
    const agyConv = agy.formatConversation([{ role: 'user', content: 'hi' }]);
    assert.match(agyConv, /\[Personalization Directive\]/);
    assert.match(agyConv, /\[Language & Communication Directive\]/);
  });
});
