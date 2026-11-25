import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  formatProjectInstructionsPrompt,
  formatProjectRulesReport,
  loadProjectInstructions
} from '../src/projectInstructions.js';
import { backgroundTaskManager } from '../src/backgroundTasks.js';
import { backgroundTaskTool } from '../src/tools/backgroundTask.js';
import { runCommand } from '../src/commands.js';

const nativeRealpath = (p: string): string =>
  typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native(p) : fs.realpathSync(p);
const TMP_ROOT = nativeRealpath(fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-phasec-rules-')));

after(() => {
  backgroundTaskManager.stopAll(true);
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch { /* ignore */ }
});

describe('Phase C-Core — Hierarchical Project Rules & Managed Background Tasks', () => {
  test('loadProjectInstructions merges global, repo-root, subdirectory, and .causyne/rules/*.md and skips symlinks', async () => {
    const repo = path.join(TMP_ROOT, 'rules-repo');
    const sub = path.join(repo, 'apps', 'web');
    const fakeHome = path.join(TMP_ROOT, 'fake-home');
    fs.mkdirSync(path.join(sub, '.causyne', 'rules'), { recursive: true });
    fs.mkdirSync(fakeHome, { recursive: true });

    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    fs.writeFileSync(path.join(fakeHome, 'CAUSYNE.md'), 'Global rule: be concise.', 'utf8');
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'Root rule: run tests.', 'utf8');
    fs.writeFileSync(path.join(sub, 'CLAUDE.md'), 'Subproject rule: strict TS.', 'utf8');
    fs.writeFileSync(path.join(sub, '.causyne', 'rules', '01-api.md'), 'Rule 1: validate input.', 'utf8');

    if (process.platform !== 'win32') {
      const secretFile = path.join(TMP_ROOT, 'outside-secret.md');
      fs.writeFileSync(secretFile, 'SHOULD_NOT_LOAD_VIA_SYMLINK', 'utf8');
      fs.symlinkSync(secretFile, path.join(sub, '.causyne', 'rules', '99-symlink.md'));
    }

    const loaded = loadProjectInstructions(sub, { CAUSYNE_HOME: fakeHome });
    assert.equal(loaded.entries.length, 4);
    assert.equal(loaded.entries[0]?.scope, 'global');
    assert.equal(loaded.entries[1]?.sourcePath.endsWith('AGENTS.md'), true);
    assert.equal(loaded.entries[2]?.sourcePath.endsWith('CLAUDE.md'), true);
    assert.equal(loaded.entries[3]?.sourcePath.endsWith('01-api.md'), true);

    const prompt = formatProjectInstructionsPrompt(loaded);
    assert.match(prompt, /Global rule: be concise/);
    assert.match(prompt, /Root rule: run tests/);
    assert.match(prompt, /Subproject rule: strict TS/);
    assert.doesNotMatch(prompt, /SHOULD_NOT_LOAD_VIA_SYMLINK/);

    const report = formatProjectRulesReport(sub, { CAUSYNE_HOME: fakeHome });
    assert.match(report, /4 file\(s\)/);

    const slashRes = await runCommand('rules', [], {
      surface: 'terminal',
      loop: { workspaceRoot: sub } as any
    });
    assert.equal(slashRes.ok, true);
    assert.match(slashRes.output || '', /Project Instructions & Rules/);
  });

  test('backgroundTaskTool launches, streams offset output, waits, lists, and stops tasks cleanly', async () => {
    const ws = path.join(TMP_ROOT, 'bg-ws');
    fs.mkdirSync(ws, { recursive: true });

    const startRes = await backgroundTaskTool.execute({
      action: 'start',
      label: 'quick-echo',
      command: `${JSON.stringify(process.execPath)} -e "console.log('LINE_ONE'); console.log('LINE_TWO');"`
    }, { workspaceRoot: ws });
    assert.equal(startRes.success, true, startRes.error);
    const started = JSON.parse(startRes.output || '{}');
    assert.ok(started.taskId);

    const waitRes = await backgroundTaskTool.execute({
      action: 'wait',
      taskId: started.taskId,
      timeoutMs: 10_000
    }, { workspaceRoot: ws });
    assert.equal(waitRes.success, true);
    const waited = JSON.parse(waitRes.output || '{}');
    assert.equal(waited.status, 'completed');
    assert.equal(waited.exitCode, 0);

    const out1 = await backgroundTaskTool.execute({
      action: 'output',
      taskId: started.taskId,
      offset: 0
    }, { workspaceRoot: ws });
    assert.equal(out1.success, true);
    const parsedOut1 = JSON.parse(out1.output || '{}');
    assert.match(parsedOut1.output, /LINE_ONE/);
    assert.match(parsedOut1.output, /LINE_TWO/);
    assert.ok(parsedOut1.nextOffset > 0);

    // Incremental read from nextOffset returns empty
    const out2 = await backgroundTaskTool.execute({
      action: 'output',
      taskId: started.taskId,
      offset: parsedOut1.nextOffset
    }, { workspaceRoot: ws });
    assert.equal(JSON.parse(out2.output || '{}').output, '');

    // Start a long-running task and cleanly stop it
    const longStart = await backgroundTaskTool.execute({
      action: 'start',
      label: 'sleeper',
      command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 15000)"`
    }, { workspaceRoot: ws });
    assert.equal(longStart.success, true);
    const longId = JSON.parse(longStart.output || '{}').taskId;

    const stopRes = await backgroundTaskTool.execute({
      action: 'stop',
      taskId: longId
    }, { workspaceRoot: ws });
    assert.equal(stopRes.success, true);
    assert.equal(JSON.parse(stopRes.output || '{}').status, 'stopped');

    const slashList = await runCommand('tasks', ['list'], { surface: 'terminal' });
    assert.equal(slashList.ok, true);
    assert.match(slashList.output || '', /Background Tasks/);

    // Verify stopped long-running child actually terminates its entire process tree promptly
    const afterWait = await backgroundTaskManager.wait(longId, 4_000);
    assert.equal(afterWait.status, 'stopped');
    assert.ok(afterWait.endedAt !== null, 'stopped task process group must terminate cleanly');
  });

  test('backgroundTaskManager preserves monotonic nextOffset across >256KiB ring-buffer rollover', async () => {
    const ws = path.join(TMP_ROOT, 'bg-rollover');
    fs.mkdirSync(ws, { recursive: true });
    const started = backgroundTaskManager.start({
      label: 'big-output',
      cwd: ws,
      workspaceRoots: [ws],
      command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('A'.repeat(300000) + 'TAIL_MARKER');"`
    });
    const done = await backgroundTaskManager.wait(started.taskId, 10_000);
    assert.equal(done.status, 'completed');
    assert.ok(done.outputBytes >= 300_011);

    const chunk1 = backgroundTaskManager.readOutput(started.taskId, 0, 32_768);
    assert.ok(chunk1.droppedChars > 0, 'droppedChars must track trimmed prefix');
    assert.ok(chunk1.nextOffset > chunk1.droppedChars);

    // Drain to end using monotonic nextOffset without looping forever
    let cursor = chunk1.nextOffset;
    let combinedTail = chunk1.output;
    for (let i = 0; i < 20; i++) {
      const next = backgroundTaskManager.readOutput(started.taskId, cursor, 32_768);
      combinedTail += next.output;
      cursor = next.nextOffset;
      if (!next.hasMore) break;
    }
    assert.match(combinedTail, /TAIL_MARKER/);
  });
});
