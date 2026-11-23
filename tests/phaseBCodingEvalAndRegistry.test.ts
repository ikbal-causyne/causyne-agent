import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { formatEvalScorecard, runCodingEvalSuite } from '../src/benchmarks/codingEval.js';
import { canonicalToolName, resolveTool, scanToolRegistry } from '../src/tools/registry.js';
import { decideTools } from '../src/decideTools.js';
import { buildToolsList } from '../src/toolsList.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const BIN_PATH = path.join(REPO_ROOT, 'bin', 'causyne.js');

describe('Phase B3/B5 — Reproducible Coding Eval Suite & Cross-Provider Registry Compatibility', () => {
  test('runCodingEvalSuite passes all 15 isolated real-repository engineering benchmarks', async () => {
    const scorecard = await runCodingEvalSuite();
    assert.equal(scorecard.totalTasks, 15);
    assert.equal(scorecard.passedTasks, 15, formatEvalScorecard(scorecard));
    assert.equal(scorecard.passRate, 1);
    const rendered = formatEvalScorecard(scorecard);
    assert.match(rendered, /15\/15 \(100\.0%\)/);
  });

  test('code_lsp and git_worktree are registered, aliased, intent-routed, and 100% cross-provider compatible', async () => {
    assert.equal(canonicalToolName('code.lsp'), 'code_lsp');
    assert.equal(canonicalToolName('go_to_definition'), 'code_lsp');
    assert.equal(canonicalToolName('git.worktree'), 'git_worktree');
    assert.equal(canonicalToolName('worktree'), 'git_worktree');
    assert.ok(resolveTool('code_lsp'));
    assert.ok(resolveTool('git_worktree'));

    const list = buildToolsList();
    const lspDecision = decideTools({ source: 'request', list, text: 'check LSP diagnostics and go to definition' });
    assert.ok(lspDecision.tools.includes('code_lsp'));

    const wtDecision = decideTools({ source: 'request', list, text: 'create an isolated worktree for parallel edit' });
    assert.ok(wtDecision.tools.includes('git_worktree'));

    const matrix = await scanToolRegistry('all');
    assert.equal(matrix.allUniversalReady, true, 'All registered tools including code_lsp and git_worktree must pass universal provider compatibility');
  });

  test('CLI subcommands lsp, worktree, diff, and eval execute cleanly end-to-end', () => {
    const env = { ...process.env, CAUSYNE_DISABLE_AUTOUPDATE: '1' };

    const lspOut = execFileSync(process.execPath, [BIN_PATH, 'lsp', 'status'], {
      cwd: REPO_ROOT,
      env,
      encoding: 'utf8'
    });
    assert.match(lspOut, /Language Server Protocol/);

    const wtOut = execFileSync(process.execPath, [BIN_PATH, 'worktree', 'list'], {
      cwd: REPO_ROOT,
      env,
      encoding: 'utf8'
    });
    assert.match(wtOut, /Git Worktrees/);

    const evalRaw = execFileSync(process.execPath, [BIN_PATH, 'eval', '--json'], {
      cwd: REPO_ROOT,
      env,
      encoding: 'utf8'
    });
    const parsed = JSON.parse(evalRaw);
    assert.equal(parsed.passedTasks, parsed.totalTasks);
    assert.equal(parsed.totalTasks, 15);
  });
});
