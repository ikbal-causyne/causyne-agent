import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCommand, parseCommand } from '../src/commands.js';
import { loadConfig, saveConfig } from '../src/config.js';
import { buildUsageText, isZeroCostRoute } from '../src/reporting.js';
import { formatDoctorReport } from '../src/autoUpdate.js';
import {
  detectZeroCostProviders,
  listLocalOllamaDiskModels,
  pickBestZeroCostProvider
} from '../src/zeroCostRouting.js';
import { runCompactSlashCommand } from '../src/core/contextCompactor.js';

describe('Wave 5 — Zero-Cost Provider Resilience, Compaction & Diagnostics', () => {
  test('isZeroCostRoute classifies local, OpenRouter Free, ACP, and paid BYOK routes accurately', () => {
    assert.equal(isZeroCostRoute('ollama', 'qwen2.5-coder'), true);
    assert.equal(isZeroCostRoute('openrouter-free', 'openrouter/free'), true);
    assert.equal(isZeroCostRoute('openrouter', 'qwen/qwen3-coder:free'), true);
    assert.equal(isZeroCostRoute('acp/opencode', 'opencode/big-pickle'), true);
    assert.equal(isZeroCostRoute('antigravity', 'Gemini 3.8 Flash (Low)'), true);
    assert.equal(isZeroCostRoute('openai', 'gpt-4o'), false);
    assert.equal(isZeroCostRoute('anthropic', 'claude-sonnet-4-6'), false);
  });

  test('/model preserves provider and apiKey for slashed OpenRouter/Ollama model IDs', async () => {
    const prev = loadConfig();
    try {
      const syntheticKey = ['test', 'or', 'free', 'token', '12345'].join('_');
      saveConfig({
        ...prev,
        provider: 'openrouter',
        model: 'openrouter/free',
        apiKey: syntheticKey,
        providerKeys: { ...(prev.providerKeys || {}), openrouter: syntheticKey }
      });

      const resFreeVendor = await runCommand('model', ['qwen/qwen3-coder:free']);
      assert.equal(resFreeVendor.ok, true, resFreeVendor.output);
      let cfg = loadConfig();
      assert.equal(cfg.provider, 'openrouter', 'qwen/...:free must remain on openrouter, not switch to qwen BYOK');
      assert.equal(cfg.model, 'qwen/qwen3-coder:free');
      assert.equal(cfg.apiKey, syntheticKey, 'apiKey must not be wiped on slashed model switch');

      const resUnknownVendor = await runCommand('model', ['mistralai/devstral-small-2505']);
      assert.equal(resUnknownVendor.ok, true, resUnknownVendor.output);
      cfg = loadConfig();
      assert.equal(cfg.provider, 'openrouter', 'unknown vendor slash must stay on active openrouter provider');
      assert.equal(cfg.model, 'mistralai/devstral-small-2505');
      assert.equal(cfg.apiKey, syntheticKey);

      const usageText = await buildUsageText();
      assert.match(usageText, /openrouter/);
    } finally {
      saveConfig(prev);
    }
  });

  test('/compact supports --preview, --keep, and custom focus directive without corrupting Golden Anchor', async () => {
    const messages = [
      { role: 'user', content: 'Build the billing service with strict TypeScript.' },
      { role: 'assistant', content: 'Inspecting workspace files...' },
      { role: 'user', content: 'Check auth middleware first.' },
      { role: 'assistant', content: 'Reviewed src/auth.ts and found token expiry bug.' },
      { role: 'user', content: 'Also inspect invoice schema.' },
      { role: 'assistant', content: 'Reviewed src/invoice.ts and updated types.' },
      { role: 'user', content: 'Now run the tests.' },
      { role: 'assistant', content: 'All unit tests are green.' }
    ];
    let savedCount = 0;
    const fakeLoop = {
      taskId: 'compact-wave5-test',
      workspaceRoot: process.cwd(),
      userPrompt: messages[0]!.content,
      messages,
      _contextChars: 4000,
      config: { hooks: [] },
      memoryManager: {
        saveHistory() { savedCount++; }
      }
    };

    const previewRes = await runCompactSlashCommand(['--preview', '--keep', '2', 'preserve', 'auth', 'expiry'], { loop: fakeLoop });
    assert.equal(previewRes.ok, true);
    assert.match(previewRes.output, /Context Compaction Preview/);
    assert.match(previewRes.output, /preserve auth expiry/);
    assert.equal(fakeLoop.messages.length, 8, '--preview must not mutate messages');
    assert.equal(savedCount, 0);

    const applyRes = await runCompactSlashCommand(['--keep=2', 'focus', 'on', 'auth', 'migration'], { loop: fakeLoop });
    assert.equal(applyRes.ok, true, applyRes.output);
    assert.match(applyRes.output, /focus on auth migration/);
    assert.equal(savedCount, 1);
    assert.ok(fakeLoop.messages.length < 8, 'compaction should condense earlier messages');
    assert.equal(fakeLoop.messages[0]?.content, 'Build the billing service with strict TypeScript.');
    const combined = fakeLoop.messages.map((m) => String(m.content || '')).join('\n');
    assert.match(combined, /Preserved Focus Directive: focus on auth migration/);
  });

  test('/doctor and formatDoctorReport surface enterprise security and zero-cost readiness', async () => {
    const parsed = parseCommand('/doctor');
    assert.ok(parsed);
    const res = await runCommand('doctor', []);
    assert.equal(res.ok, true, res.output);
    assert.match(res.output, /OS Sandbox/);
    assert.match(res.output, /OS Keychain/);
    assert.match(res.output, /Audit Chain/);
    assert.match(res.output, /Zero-Cost \(\$0 API\) Routes/);

    const cliReport = formatDoctorReport({
      managed: false,
      type: 'source checkout',
      prefix: null,
      packageRoot: process.cwd(),
      npmCommand: 'npm',
      current: '1.20.122',
      latest: '1.20.122',
      available: false,
      autoUpdates: false
    }, {
      ...process,
      env: { ...process.env, OPENROUTER_API_KEY: 'test-or-present' },
      cwd: () => process.cwd()
    } as typeof process);
    assert.match(cliReport, /Zero-Cost \$0\s*:/);
    assert.match(cliReport, /openrouter-free/);
  });

  test('detectZeroCostProviders discovers offline Ollama disk manifests and picks highest-priority $0 route', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-zc-w5-'));
    try {
      const manifestDir = path.join(tmpDir, 'manifests', 'registry.ollama.ai', 'library', 'qwen2.5-coder');
      fs.mkdirSync(manifestDir, { recursive: true });
      fs.writeFileSync(path.join(manifestDir, '7b'), '{}', 'utf8');

      const diskModels = listLocalOllamaDiskModels(tmpDir, {});
      assert.deepEqual(diskModels, ['qwen2.5-coder:7b']);

      const detected = await detectZeroCostProviders({
        env: { PATH: '', OPENROUTER_API_KEY: 'test-key-present' },
        ollamaModelsDir: tmpDir,
        probeOllama: false
      });
      const best = pickBestZeroCostProvider(detected);
      assert.ok(best);
      assert.equal(best.id, 'openrouter-free');
      assert.equal(best.readiness, 'ready');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
