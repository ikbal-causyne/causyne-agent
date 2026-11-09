import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatPrompt } from '../src/tui/prompt.js';
import { suggest, detectTrigger } from '../src/tui/completion.js';
import { isCommandInput, runCommand } from '../src/commands.js';

const out = () => ({ columns: 100, isTTY: true, write() { return true; }, on() {}, removeListener() {} });
const input = () => ({ isTTY: true, setRawMode() {}, resume() {}, pause() {}, on() {}, off() {} });
function prompt(root = process.cwd()) {
  return new ChatPrompt({ out: out(), input: input(), root, isCommand: isCommandInput,
    history: { add() { return true; } } });
}

test('completion uses UTF-16 offsets while editor retains code-point columns', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-unicode-complete-'));
  try {
    fs.writeFileSync(path.join(root, 'alpha.txt'), 'x');
    const editor = prompt(root);
    editor.editor.setText('😀 @al');
    assert.equal(editor.cursorOffset(), '😀 @al'.length);
    editor.openCompletion();
    assert.ok(editor.completion);
    assert.equal(editor.completion.kind, 'file');
    assert.equal(editor.completion.items[0].value, 'alpha.txt');
    editor.acceptCompletion();
    assert.equal(editor.editor.getText(), '😀 @alpha.txt ');
    assert.equal(editor.cursorOffset(), '😀 @alpha.txt '.length);
    editor.setCursorOffset('😀 '.length);
    assert.equal(editor.editor.col, 2, 'emoji + space is two code points');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a symlink to an external directory cannot expose filenames through @ completion', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-scope-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-private-'));
  try {
    fs.writeFileSync(path.join(outside, 'sensitive-invoice.txt'), 'private');
    try { fs.symlinkSync(outside, path.join(root, 'outsideLink'), 'dir'); }
    catch (e) {
      if (e.code === 'EPERM' || e.code === 'ENOSYS') { t.skip('Symlink creation unsupported'); return; }
      throw e;
    }
    assert.equal(suggest('@outside', '@outside'.length, { root }), null,
      'external symlinks must not even appear in root-level suggestions');
    assert.equal(suggest('@outside', '@outside'.length, { root }), null,
      'external symlinks must not appear in root suggestions');
    assert.equal(suggest('@outsideLink/sens', '@outsideLink/sens'.length, { root }), null,
      'symlinked folder outside root must not appear in completed paths');
    assert.equal(suggest('@sensitive', '@sensitive'.length,
      { root, focusDir: 'outsideLink' }), null,
      'focusDir must also respect physical workspace boundaries');
    const allowed = path.join(root, 'inside');
    fs.mkdirSync(allowed);
    fs.writeFileSync(path.join(allowed, 'safe.txt'), 'safe');
    fs.symlinkSync(allowed, path.join(root, 'insideLink'), 'dir');
    const okay = suggest('@insideLink/sa', '@insideLink/sa'.length, { root });
    assert.ok(okay?.items.some(item => item.value === 'insideLink/safe.txt'),
      'a symlink that physically remains inside root should still complete');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('unknown /new-prefix commands do not interrupt the current task', () => {
  const p = prompt();
  let interrupts = 0;
  p.interrupt = () => { interrupts++; };
  p.erase = () => {};
  p.scheduleDraw = () => {};
  p.busy = true;
  p.editor.setText('/newsletter');
  p.submit();
  assert.equal(interrupts, 0);
  assert.deepEqual(p.queue, ['/newsletter']);
  p.queue = [];
  p.editor.setText('/modelxyz');
  p.submit();
  assert.equal(interrupts, 0);
  p.queue = [];
  p.editor.setText('/modelxyz');
  p.submit();
  assert.equal(interrupts, 0);
  p.queue = [];
  p.editor.setText('/new');
  p.submit();
  assert.equal(interrupts, 1, 'exact /new remains interruptible');
});

test('slash /cd emits explicit workspace-switch event rather than mutating stale loop state', async () => {
  const oldCwd = process.cwd();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-next-project-'));
  try {
    const oldLoop = { workspaceRoot: oldCwd, workspaceContext: { cwd: oldCwd },
      sandbox: { workspacePaths: [oldCwd] } };
    const result = await runCommand('cd', [project], { surface: 'terminal', loop: oldLoop });
    assert.equal(result.ok, true, result.output);
    assert.equal(result.effect, 'workspace-changed');
    assert.equal(result.workspaceRoot, fs.realpathSync(project));
    assert.equal(process.cwd(), fs.realpathSync(project));
    assert.equal(oldLoop.workspaceRoot, oldCwd);
    assert.deepEqual(oldLoop.sandbox.workspacePaths, [oldCwd]);
  } finally {
    process.chdir(oldCwd);
    fs.rmSync(project, { recursive: true, force: true });
  }
});
