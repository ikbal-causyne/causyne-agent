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
import { applyPatch } from '../tools/applyPatch.js';
import { buildRepoMap } from '../codebase/repoMap.js';
import { loadProjectInstructions } from '../projectInstructions.js';
import { backgroundTaskManager } from '../backgroundTasks.js';

export interface CodingEvalTaskResult {
  id: string;
  category:
    | 'bugfix'
    | 'refactor'
    | 'parallel-worktree'
    | 'governance'
    | 'diff-review'
    | 'multi-file-patch'
    | 'repo-map'
    | 'project-rules'
    | 'background-task';
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
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir, stdio: 'ignore', windowsHide: true });
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-eval-'));
  const root = typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native(tmpDir) : fs.realpathSync(tmpDir);
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

    // Task 6: Transactional multi-file apply_patch verified by real node --test
    {
      const start = Date.now();
      const repo = initTempGitRepo(root, 'task6-apply-patch');
      fs.writeFileSync(path.join(repo, 'core.mjs'), 'export const FACTOR = 2;\n', 'utf8');
      fs.writeFileSync(path.join(repo, 'calc.mjs'), "import { FACTOR } from './core.mjs';\nexport const scale = (n) => n * FACTOR;\n", 'utf8');
      fs.writeFileSync(path.join(repo, 'calc.test.mjs'), [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { scale } from './calc.mjs';",
        "import { OFFSET } from './offset.mjs';",
        "test('multi-file patch applied cleanly', () => {",
        '  assert.equal(scale(5) + OFFSET, 16);',
        '});',
        ''
      ].join('\n'), 'utf8');
      commitAll(repo, 'init');

      const patchRes = await applyPatch.execute({
        patch: [
          '*** Begin Patch',
          '*** Add File: offset.mjs',
          '+export const OFFSET = 1;',
          '*** Update File: core.mjs',
          '@@',
          '-export const FACTOR = 2;',
          '+export const FACTOR = 3;',
          '*** End Patch'
        ].join('\n')
      }, { workspaceRoot: repo });
      const passed = patchRes.success && runNodeTest(repo, 'calc.test.mjs');
      results.push({
        id: 'multi-file-apply-patch',
        category: 'multi-file-patch',
        passed,
        elapsedMs: Date.now() - start,
        detail: passed
          ? 'Atomic multi-file patch (add + update) verified by node --test.'
          : (patchRes.error || 'calc.test.mjs failed.')
      });
    }

    // Task 7: PageRank repo map dependency centrality ranking
    {
      const start = Date.now();
      const repo = initTempGitRepo(root, 'task7-repomap');
      fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'src', 'hub.ts'), 'export interface CoreState { id: string; }\nexport function createState(): CoreState { return { id: "1" }; }\n', 'utf8');
      fs.writeFileSync(path.join(repo, 'src', 'a.ts'), "import { createState } from './hub.js';\nexport const a = () => createState();\n", 'utf8');
      fs.writeFileSync(path.join(repo, 'src', 'b.ts'), "import { createState } from './hub.js';\nexport const b = () => createState();\n", 'utf8');
      fs.writeFileSync(path.join(repo, 'src', 'c.ts'), "import { createState } from './hub.js';\nexport const c = () => createState();\n", 'utf8');
      fs.writeFileSync(path.join(repo, 'src', 'leaf.ts'), 'export const lonely = 1;\n', 'utf8');

      const map = buildRepoMap(repo, { maxChars: 4000 });
      const passed = map.files.length === 5 && map.files[0]?.relPath === 'src/hub.ts';
      results.push({
        id: 'repo-map-centrality',
        category: 'repo-map',
        passed,
        elapsedMs: Date.now() - start,
        detail: passed
          ? 'PageRank ranked most-imported hub module #1 above leaf modules.'
          : `Expected src/hub.ts at rank #1, got ${map.files[0]?.relPath || '(none)'}.`
      });
    }

    // Task 8: Hierarchical project instructions precedence (root -> subproject -> rules)
    {
      const start = Date.now();
      const repo = initTempGitRepo(root, 'task8-rules');
      const sub = path.join(repo, 'packages', 'api');
      fs.mkdirSync(path.join(sub, '.causyne', 'rules'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Root Rule\nAlways run strict typecheck.\n', 'utf8');
      fs.writeFileSync(path.join(sub, 'CAUSYNE.md'), '# API Rule\nKeep handlers pure.\n', 'utf8');
      fs.writeFileSync(path.join(sub, '.causyne', 'rules', '01-security.md'), 'Validate every payload.\n', 'utf8');

      const loaded = loadProjectInstructions(sub, { CAUSYNE_HOME: path.join(root, 'empty-home') });
      const passed = loaded.entries.length === 3
        && loaded.entries[0]!.sourcePath.endsWith('AGENTS.md')
        && loaded.entries[1]!.sourcePath.endsWith('CAUSYNE.md')
        && loaded.entries[2]!.sourcePath.endsWith('01-security.md');
      results.push({
        id: 'hierarchical-project-rules',
        category: 'project-rules',
        passed,
        elapsedMs: Date.now() - start,
        detail: passed
          ? 'Discovered and ordered root AGENTS.md, subproject CAUSYNE.md, and .causyne/rules/*.md.'
          : `Unexpected instruction entries (${loaded.entries.length}).`
      });
    }

    // Task 9: Managed sandboxed background task lifecycle
    {
      const start = Date.now();
      const repo = initTempGitRepo(root, 'task9-bgtask');
      const started = backgroundTaskManager.start({
        command: `${JSON.stringify(process.execPath)} -e "console.log('BG_EVAL_OK')"`,
        cwd: repo,
        workspaceRoots: [repo],
        label: 'eval-bg'
      });
      const finalSnap = await backgroundTaskManager.wait(started.taskId, 10_000);
      const out = backgroundTaskManager.readOutput(started.taskId, 0);
      const passed = finalSnap.status === 'completed' && finalSnap.exitCode === 0 && out.output.includes('BG_EVAL_OK');
      results.push({
        id: 'managed-background-task',
        category: 'background-task',
        passed,
        elapsedMs: Date.now() - start,
        detail: passed
          ? 'OS-sandboxed background task streamed output and completed with exit 0.'
          : `Background task status=${finalSnap.status} exit=${String(finalSnap.exitCode)}.`
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
