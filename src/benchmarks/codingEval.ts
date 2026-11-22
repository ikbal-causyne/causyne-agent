/**
 * Causyne Agent — Reproducible Real-Repository Coding Eval Suite (Phase B3)
 *
 * Benchmarks core software-engineering harness capabilities in isolated
 * temporary Git repositories with real `node --test` verification:
 *   1. Surgical single-file bugfix (`fsRead` + `fsEdit`)
 *   2. Atomic multi-hunk refactoring (`MultiEdit`)
 *   3. Conflict-free parallel Git worktree execution & merge (`worktreeManager`)
 *   4. Structured diff parsing + enterprise policy fail-closed gate
 *   5. Optional pluggable live LLM solver hook for real-model scorecards
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fsRead } from '../tools/fsRead.js';
import { fsEdit } from '../tools/fsEdit.js';
import { multiEdit } from '../tools/multiEdit.js';
import { createWorktree, inspectWorktreeDiff, mergeWorktree } from '../worktreeManager.js';
import { collectWorkingTreeDiff } from '../diffReview.js';
import { evaluateEnterprisePolicy, loadEnterprisePolicy } from '../enterprisePolicy.js';

export interface CodingEvalTaskResult {
  id: string;
  category: 'bugfix' | 'refactor' | 'parallel-worktree' | 'governance' | 'diff-review';
  passed: boolean;
  elapsedMs: number;
  detail: string;
  promptTokens?: number | undefined;
  cachedTokens?: number | undefined;
  completionTokens?: number | undefined;
}

export interface CodingEvalScorecard {
  timestamp: string;
  totalTasks: number;
  passedTasks: number;
  passRate: number;
  totalElapsedMs: number;
  results: CodingEvalTaskResult[];
}

export type ExternalEvalSolver = (task: {
  id: string;
  repoDir: string;
  prompt: string;
}) => Promise<{
  promptTokens?: number;
  cachedTokens?: number;
  completionTokens?: number;
}>;

function initTempGitRepo(rootDir: string, name: string): string {
  const dir = path.join(rootDir, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'eval@causyne.local'], { cwd: dir, stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'Causyne Eval'], { cwd: dir, stdio: 'ignore', windowsHide: true });
  return dir;
}

function commitAll(repoDir: string, message: string): void {
  execFileSync('git', ['add', '--all'], { cwd: repoDir, stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['commit', '-m', message], { cwd: repoDir, stdio: 'ignore', windowsHide: true });
}

function runNodeTest(repoDir: string, testFile: string): boolean {
  try {
    execFileSync(process.execPath, ['--test', testFile], {
      cwd: repoDir,
      stdio: 'pipe',
      timeout: 15_000,
      windowsHide: true
    });
    return true;
  } catch {
    return false;
  }
}

export async function runCodingEvalSuite(options: {
  solver?: ExternalEvalSolver | undefined;
} = {}): Promise<CodingEvalScorecard> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-eval-')));
  const suiteStart = Date.now();
  const results: CodingEvalTaskResult[] = [];

  try {
    // Task 1: Surgical bugfix verified by real node --test
    {
      const start = Date.now();
      const repo = initTempGitRepo(root, 'task1-bugfix');
      fs.writeFileSync(path.join(repo, 'math.mjs'), [
        'export function clampRange(value, min, max) {',
        '  if (value < min) return min;',
        '  if (value > max) return min; // BUG: returns min instead of max',
        '  return value;',
        '}',
        ''
      ].join('\n'), 'utf8');
      fs.writeFileSync(path.join(repo, 'math.test.mjs'), [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { clampRange } from './math.mjs';",
        "test('clampRange clamps both bounds', () => {",
        '  assert.equal(clampRange(-5, 0, 10), 0);',
        '  assert.equal(clampRange(5, 0, 10), 5);',
        '  assert.equal(clampRange(42, 0, 10), 10);',
        '});',
        ''
      ].join('\n'), 'utf8');
      commitAll(repo, 'init');

      let usage: { promptTokens?: number; cachedTokens?: number; completionTokens?: number } = {};
      if (options.solver) {
        usage = await options.solver({
          id: 'bugfix-clamp-range',
          repoDir: repo,
          prompt: 'Fix clampRange in math.mjs so math.test.mjs passes.'
        });
      } else {
        const readRes = await fsRead.execute({ path: path.join(repo, 'math.mjs') }, { workspaceRoot: repo });
        if (readRes.success) {
          await fsEdit.execute({
            path: 'math.mjs',
            edits: [{
              searchContent: 'if (value > max) return min; // BUG: returns min instead of max',
              replaceContent: 'if (value > max) return max;'
            }]
          }, { workspaceRoot: repo });
        }
      }
      const passed = runNodeTest(repo, 'math.test.mjs');
      results.push({
        id: 'bugfix-clamp-range',
        category: 'bugfix',
        passed,
        elapsedMs: Date.now() - start,
        detail: passed ? 'Real node --test verified surgical bugfix.' : 'math.test.mjs failed.',
        ...usage
      });
    }

    // Task 2: Atomic multi-hunk refactor via MultiEdit
    {
      const start = Date.now();
      const repo = initTempGitRepo(root, 'task2-refactor');
      fs.writeFileSync(path.join(repo, 'format.mjs'), [
        'export function formatCurrency(amount) {',
        '  return "$" + amount.toFixed(1);',
        '}',
        'export function formatPercent(ratio) {',
        '  return Math.round(ratio * 10) + "%";',
        '}',
        ''
      ].join('\n'), 'utf8');
      fs.writeFileSync(path.join(repo, 'format.test.mjs'), [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { formatCurrency, formatPercent } from './format.mjs';",
        "test('formatters use 2 decimals and full percentage', () => {",
        "  assert.equal(formatCurrency(12.5), '$12.50');",
        "  assert.equal(formatPercent(0.75), '75%');",
        '});',
        ''
      ].join('\n'), 'utf8');
      commitAll(repo, 'init');

      let usage: { promptTokens?: number; cachedTokens?: number; completionTokens?: number } = {};
      if (options.solver) {
        usage = await options.solver({
          id: 'refactor-multi-edit',
          repoDir: repo,
          prompt: 'Update formatCurrency (2 decimals) and formatPercent (* 100) in format.mjs so format.test.mjs passes.'
        });
      } else {
        await multiEdit.execute({
          file_path: 'format.mjs',
          edits: [
            { old_string: 'amount.toFixed(1)', new_string: 'amount.toFixed(2)' },
            { old_string: 'Math.round(ratio * 10)', new_string: 'Math.round(ratio * 100)' }
          ]
        }, { workspaceRoot: repo });
      }
      const passed = runNodeTest(repo, 'format.test.mjs');
      results.push({
        id: 'refactor-multi-edit',
        category: 'refactor',
        passed,
        elapsedMs: Date.now() - start,
        detail: passed ? 'Atomic multi-hunk refactor verified by node --test.' : 'format.test.mjs failed.',
        ...usage
      });
    }

    // Task 3: Parallel Git Worktree isolation & conflict-free merge
    {
      const start = Date.now();
      const repo = initTempGitRepo(root, 'task3-worktree');
      fs.writeFileSync(path.join(repo, 'index.mjs'), 'export const VERSION = 1;\n', 'utf8');
      commitAll(repo, 'init');

      const wtA = createWorktree(repo, { name: 'worker-a' });
      const wtB = createWorktree(repo, { name: 'worker-b' });
      fs.writeFileSync(path.join(wtA.path, 'featureA.mjs'), 'export const a = 42;\n', 'utf8');
      fs.writeFileSync(path.join(wtB.path, 'featureB.mjs'), 'export const b = 58;\n', 'utf8');

      const diffA = inspectWorktreeDiff(repo, wtA.id);
      const mergeA = mergeWorktree(repo, wtA.id, { cleanup: true, commitMessage: 'add featureA' });
      const mergeB = mergeWorktree(repo, wtB.id, { cleanup: true, commitMessage: 'add featureB' });

      const bothExist = fs.existsSync(path.join(repo, 'featureA.mjs')) && fs.existsSync(path.join(repo, 'featureB.mjs'));
      const passed = diffA.changedFiles.includes('featureA.mjs') && mergeA.merged && mergeB.merged && bothExist;
      results.push({
        id: 'parallel-worktree-merge',
        category: 'parallel-worktree',
        passed,
        elapsedMs: Date.now() - start,
        detail: passed
          ? 'Two parallel isolated git worktrees merged cleanly with zero collisions.'
          : 'Parallel worktree creation or merge failed.'
      });
    }

    // Task 4: Structured diff review accuracy
    {
      const start = Date.now();
      const repo = initTempGitRepo(root, 'task4-diff');
      fs.writeFileSync(path.join(repo, 'app.mjs'), 'export const x = 1;\nexport const y = 2;\n', 'utf8');
      commitAll(repo, 'init');
      fs.writeFileSync(path.join(repo, 'app.mjs'), 'export const x = 10;\nexport const y = 2;\nexport const z = 3;\n', 'utf8');

      const report = collectWorkingTreeDiff(repo);
      const passed = report.files.length === 1
        && report.files[0]?.displayPath === 'app.mjs'
        && report.totalAdditions === 2
        && report.totalDeletions === 1;
      results.push({
        id: 'structured-diff-review',
        category: 'diff-review',
        passed,
        elapsedMs: Date.now() - start,
        detail: passed
          ? 'Unified diff parser computed exact file/hunk addition and deletion counts.'
          : `Unexpected diff stats (+${report.totalAdditions}/-${report.totalDeletions}).`
      });
    }

    // Task 5: Enterprise policy governance fail-closed verification
    {
      const start = Date.now();
      const repo = initTempGitRepo(root, 'task5-governance');
      fs.writeFileSync(path.join(repo, 'causyne.policy.json'), JSON.stringify({
        version: 1,
        commands: { deny: ['rm -rf /*'], ask: ['git push*'], allow: ['npm test*'] },
        paths: { deny: ['**/.env*'] }
      }), 'utf8');
      const loaded = loadEnterprisePolicy(repo, { CAUSYNE_HOME: root });
      const denied = evaluateEnterprisePolicy({ tool: 'sysRun', args: { command: 'rm -rf /etc' }, workspaceRoot: repo }, loaded);
      const asked = evaluateEnterprisePolicy({ tool: 'sysRun', args: { command: 'git push origin main' }, workspaceRoot: repo }, loaded);
      const secretDenied = evaluateEnterprisePolicy({ tool: 'fs_read', args: { path: path.join(repo, '.env.prod') }, workspaceRoot: repo }, loaded);

      const passed = denied.effect === 'deny' && asked.effect === 'ask' && secretDenied.effect === 'deny';
      results.push({
        id: 'enterprise-policy-gate',
        category: 'governance',
        passed,
        elapsedMs: Date.now() - start,
        detail: passed
          ? 'Enterprise policy deterministically enforced deny/ask rules.'
          : 'Enterprise policy evaluation mismatch.'
      });
    }
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  const passedTasks = results.filter((r) => r.passed).length;
  return {
    timestamp: new Date().toISOString(),
    totalTasks: results.length,
    passedTasks,
    passRate: results.length > 0 ? passedTasks / results.length : 0,
    totalElapsedMs: Date.now() - suiteStart,
    results
  };
}

export function formatEvalScorecard(scorecard: CodingEvalScorecard): string {
  const pct = (scorecard.passRate * 100).toFixed(1);
  const lines = [
    `Causyne Coding Eval Scorecard — ${scorecard.passedTasks}/${scorecard.totalTasks} (${pct}%) in ${scorecard.totalElapsedMs}ms`,
    ''
  ];
  for (const r of scorecard.results) {
    const icon = r.passed ? '✓' : '✗';
    lines.push(`  ${icon} [${r.category}] ${r.id} (${r.elapsedMs}ms) — ${r.detail}`);
  }
  return lines.join('\n');
}
