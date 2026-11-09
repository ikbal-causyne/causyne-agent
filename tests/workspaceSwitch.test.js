import test from 'node:test';
import assert from 'node:assert/strict';
import { switchChatWorkspace } from '../src/tui/workspaceSwitch.js';

test('/cd creates a fresh agent and rebinds the TUI without leaking the previous workspace', () => {
  const oldRoot = '/project/alpha';
  const nextRoot = '/project/beta';
  const previous = { workspaceRoot: oldRoot, activeSkill: { id: 'old/skill' },
    sandbox: { workspacePaths: [oldRoot] }, memoryManager: { workspace: oldRoot } };
  let nextLoop;
  const prompt = {
    root: oldRoot, messageActionLoop: previous,
    pendingAttachments: [{ path: '/project/alpha/secret' }], completion: { kind: 'file' },
    setWorkingRoot(root) { this.root = root; }, scheduleDraw() { this.redrawn = true; }
  };
  const header = { cwd: oldRoot, workspace: oldRoot };
  const surface = { setSessionInfo(info) { this.info = info; } };
  const renderer = { status: { setSession(info) { this.info = { ...info }; } } };
  const next = switchChatWorkspace({
    workspaceRoot: nextRoot,
    createLoop(root) {
      nextLoop = { workspaceRoot: root, sandbox: { workspacePaths: [root] },
        memoryManager: { workspace: root }, activeSkill: null };
      return nextLoop;
    },
    prompt, surface, renderer, headerInfo: header,
    approvalHandler: () => true, decisionHandler: () => null
  });
  assert.notEqual(next, previous);
  assert.equal(next, nextLoop);
  assert.equal(next.sandbox.workspacePaths[0], nextRoot);
  assert.equal(next.memoryManager.workspace, nextRoot);
  assert.equal(prompt.root, nextRoot);
  assert.equal(prompt.messageActionLoop, next);
  assert.deepEqual(prompt.pendingAttachments, []);
  assert.equal(prompt.completion, null);
  assert.equal(header.workspace, nextRoot);
  assert.equal(renderer.status.info.cwd, nextRoot);
  assert.equal(surface.info.activeSkill, null);
  assert.equal(previous.workspaceRoot, oldRoot);
  assert.deepEqual(previous.sandbox.workspacePaths, [oldRoot]);
});

test('/cd refuses an incorrectly scoped replacement before updating TUI', () => {
  const prompt = { root: '/old', setWorkingRoot(root) { this.root = root; } };
  assert.throws(() => switchChatWorkspace({
    workspaceRoot: '/next', prompt,
    createLoop(root) { return { workspaceRoot: root, sandbox: { workspacePaths: ['/old'] } }; },
    approvalHandler: () => true, decisionHandler: () => null
  }), /sandbox did not adopt/);
  assert.equal(prompt.root, '/old');
});
