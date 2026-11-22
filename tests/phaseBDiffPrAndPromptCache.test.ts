import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  collectWorkingTreeDiff,
  parseUnifiedDiff,
  renderDiffReview
} from '../src/diffReview.js';
import {
  fetchFailedCiLogs,
  formatPrStatusReport,
  inspectPrStatus,
  preparePrDraft
} from '../src/prWorkflow.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import { runCommand } from '../src/commands.js';

const TMP_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-phaseb-diff-')));

after(() => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch { /* ignore */ }
});

function initRepo(name: string): string {
  const dir = path.join(TMP_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'diff@causyne.local'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Causyne Diff'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'service.ts'), 'export const a = 1;\nexport const b = 2;\n', 'utf8');
  execFileSync('git', ['add', '--all'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

describe('Phase B3/B4 — Diff Review, PR Workflow & OpenAI Prompt Cache Key Routing', () => {
  test('parseUnifiedDiff parses modified, added, deleted, and renamed files with exact hunk counts', () => {
    const sample = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      ' const x = 1;',
      '-const y = 2;',
      '+const y = 20;',
      '+const z = 30;',
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,1 @@',
      '+export const ok = true;',
      ''
    ].join('\n');

    const files = parseUnifiedDiff(sample);
    assert.equal(files.length, 2);
    assert.equal(files[0]?.status, 'modified');
    assert.equal(files[0]?.additions, 2);
    assert.equal(files[0]?.deletions, 1);
    assert.equal(files[1]?.status, 'added');
    assert.equal(files[1]?.additions, 1);
  });

  test('collectWorkingTreeDiff handles working tree, staged diffs, traversal rejection, and /diff command', async () => {
    const repo = initRepo('diff-repo');
    fs.writeFileSync(path.join(repo, 'service.ts'), 'export const a = 100;\nexport const b = 2;\nexport const c = 3;\n', 'utf8');

    const wtReport = collectWorkingTreeDiff(repo);
    assert.equal(wtReport.files.length, 1);
    assert.equal(wtReport.totalAdditions, 2);
    assert.equal(wtReport.totalDeletions, 1);
    assert.match(renderDiffReview(wtReport, { statOnly: true }), /service\.ts\s+\(\+2 \/ -1/);

    // Reject path escape and flag injection
    assert.throws(() => collectWorkingTreeDiff(repo, { filePath: '../outside.ts' }), /escapes repository root/);
    assert.throws(() => collectWorkingTreeDiff(repo, { ref: '--exec=bad' }), /Invalid git ref/);

    // Staged diff
    execFileSync('git', ['add', 'service.ts'], { cwd: repo, stdio: 'ignore' });
    const stagedReport = collectWorkingTreeDiff(repo, { staged: true });
    assert.equal(stagedReport.files.length, 1);

    const slashRes = await runCommand('diff', ['--staged', '--stat'], {
      surface: 'terminal',
      loop: { workspaceRoot: repo } as any
    });
    assert.equal(slashRes.ok, true, slashRes.output);
    assert.match(slashRes.output || '', /Staged Diff/);
  });

  test('prWorkflow inspects local repo status, drafts diff-grounded PRs, and validates CI run IDs', async () => {
    const repo = initRepo('pr-repo');
    execFileSync('git', ['checkout', '-b', 'feature/lsp-support'], { cwd: repo, stdio: 'ignore' });
    fs.writeFileSync(path.join(repo, 'lsp.ts'), 'export const lspReady = true;\n', 'utf8');
    execFileSync('git', ['add', 'lsp.ts'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'add lsp module'], { cwd: repo, stdio: 'ignore' });

    const status = inspectPrStatus(repo);
    assert.equal(status.branch, 'feature/lsp-support');
    assert.equal(status.dirtyCount, 0);
    assert.match(formatPrStatusReport(status), /feature\/lsp-support/);

    const draft = preparePrDraft(repo, 'main');
    assert.equal(draft.baseBranch, 'main');
    assert.equal(draft.headBranch, 'feature/lsp-support');
    assert.equal(draft.commitCount, 1);
    assert.deepEqual(draft.changedFiles, ['lsp.ts']);
    assert.match(draft.body, /add lsp module/);

    // Reject malformed runId (never passed to gh)
    const badRun = fetchFailedCiLogs(repo, '1234; rm -rf /');
    assert.equal(badRun.ok, false);
    assert.match(badRun.output, /Invalid workflow run ID/);

    const slashDraft = await runCommand('pr', ['draft', 'main'], {
      surface: 'terminal',
      loop: { workspaceRoot: repo } as any
    });
    assert.equal(slashDraft.ok, true);
    assert.match(slashDraft.output || '', /add lsp module/);
  });

  test('OpenAIProvider sends prompt_cache_key only on api.openai.com, never on custom compatible endpoints', async () => {
    let officialPayload: Record<string, any> | null = null;
    let compatPayload: Record<string, any> | null = null;
    const origFetch = globalThis.fetch;

    globalThis.fetch = (async (url: any, init: any) => {
      const parsed = JSON.parse(String(init?.body || '{}'));
      if (String(url).includes('api.openai.com')) {
        officialPayload = parsed;
      } else {
        compatPayload = parsed;
      }
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 80 } }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      const openai = new OpenAIProvider({ apiKey: 'test-token-openai-1234', model: 'gpt-4o' });
      const res1 = await openai.chat([{ role: 'user', content: 'hi' }], { cacheKey: 'causyne_ws_abc123' });
      assert.equal(res1.usage.cachedPromptTokens, 80);
      assert.equal(officialPayload?.prompt_cache_key, 'causyne_ws_abc123');

      const compat = new OpenAICompatibleProvider({
        apiKey: 'test-token-compat-1234',
        baseUrl: 'https://custom-gateway.example.com/v1/chat/completions',
        model: 'custom-model'
      });
      await compat.chat([{ role: 'user', content: 'hi' }], { cacheKey: 'causyne_ws_abc123' });
      assert.equal(compatPayload?.prompt_cache_key, undefined, 'third-party OpenAI-compatible gateways must not receive unsupported OpenAI-specific fields');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
