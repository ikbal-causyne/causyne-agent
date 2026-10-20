import test from 'node:test';
import assert from 'node:assert/strict';

import { runConfiguredHooks } from '../src/hooks.js';

const passCommand = [
  process.execPath,
  '-e',
  "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const p=JSON.parse(s);process.stdout.write(p.event+':'+p.tool)})"
];

test('hooks: matching argv hook receives structured input without a shell', async () => {
  const result = await runConfiguredHooks({
    hooks: [{ event: 'PreToolUse', tool: 'fs_write', command: passCommand }],
    event: 'PreToolUse',
    toolName: 'fs_write',
    args: { path: '/tmp/example' },
    taskId: 'task-1',
    workspacePaths: [process.cwd()]
  });

  assert.equal(result.denied, false);
  assert.match(result.messages[0], /PreToolUse:fs_write/);
});

test('hooks: a pre-tool exit code 2 denies before execution', async () => {
  const result = await runConfiguredHooks({
    hooks: [{
      name: 'policy',
      event: 'PreToolUse',
      tool: '*',
      command: [process.execPath, '-e', "process.stdout.write('blocked by policy');process.exit(2)"]
    }],
    event: 'PreToolUse',
    toolName: 'sysRun',
    args: {},
    workspacePaths: [process.cwd()]
  });

  assert.equal(result.denied, true);
  assert.match(result.reason, /blocked by policy/);
});

test('hooks: a broken pre-tool policy fails closed while post-tool diagnostics only annotate', async () => {
  const command = [process.execPath, '-e', "process.stderr.write('hook failed');process.exit(1)"];
  const pre = await runConfiguredHooks({
    hooks: [{ event: 'PreToolUse', tool: '*', command }],
    event: 'PreToolUse', toolName: 'fs_read', args: {}, workspacePaths: [process.cwd()]
  });
  const post = await runConfiguredHooks({
    hooks: [{ event: 'PostToolUse', tool: '*', command }],
    event: 'PostToolUse', toolName: 'fs_read', args: {}, result: { success: true },
    workspacePaths: [process.cwd()]
  });

  assert.equal(pre.denied, true);
  assert.equal(post.denied, false);
  assert.match(post.messages[0], /hook failed/);
});

test('hooks: unrelated tools pay zero process cost and produce no feedback', async () => {
  const result = await runConfiguredHooks({
    hooks: [{ event: 'PreToolUse', tool: 'fs_write', command: passCommand }],
    event: 'PreToolUse', toolName: 'fs_read', args: {}, workspacePaths: [process.cwd()]
  });
  assert.deepEqual(result, { denied: false, messages: [] });
});
