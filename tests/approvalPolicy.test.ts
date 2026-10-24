import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  currentToolAutonomyMode, isAutonomousToolContext, isWholeFileDeletion,
  requiresToolApproval, withToolAutonomyMode
} from '../src/approvalPolicy.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../src/agentLoop.js';
import { AGENT_USER_POLICY } from '../src/agentPolicy.js';
import { toolRegistry } from '../src/tools/registry.js';
import { Sandbox } from '../src/sandbox.js';

function needsApproval(mode: string, tool: string, args: Record<string, unknown>,
  risk = 'extreme', standingApproval = false, heavyDownload = false): boolean {
  return requiresToolApproval({ mode, tool, args, risk, standingApproval, heavyDownload });
}

test('Mode C runs ordinary in-scope edits and extreme tools without repeated approval', () => {
  assert.equal(needsApproval('C', 'fs_edit', { path: 'app.ts' }), false);
  assert.equal(needsApproval('C', 'MultiEdit', { file_path: 'app.ts' }), false);
  assert.equal(needsApproval('C', 'fs_write', { path: 'app.ts' }), false);
  assert.equal(needsApproval('C', 'desktop_act', { action: 'click' }), false);
  assert.equal(needsApproval('C', 'manage_local_dependencies', { action: 'pipInst' }, 'extreme', false, true), false);
});

test('Mode C asks for whole-file deletion until the session has a standing grant', () => {
  assert.equal(needsApproval('C', 'fs_delete', { path: 'app.ts' }, 'dangerous', false), true);
  assert.equal(needsApproval('C', 'fs_delete', { path: 'app.ts' }, 'dangerous', true), false);
  assert.equal(needsApproval('C', 'fs_delete', { path: 'folder', recursive: true }, 'extreme'), true);
  assert.equal(needsApproval('C', 'sysRun', { command: 'cd project && rm old.ts' }, 'dangerous'), true);
  assert.equal(needsApproval('C', 'sysRun', { command: 'rm old.ts' }, 'dangerous', true), true);
  assert.equal(needsApproval('C', 'sysRun', { command: 'bash -c "rm old.ts"' }, 'dangerous'), true);
  assert.equal(needsApproval('C', 'sysRun', { command: 'python3 -c "import os; os.remove(\'old.ts\')"' }, 'moderate'), true);
  assert.equal(needsApproval('C', 'gitOp', { command: 'rm old.ts' }, 'dangerous'), true);
});

test('line edits and read-only mentions of deletion are not file deletion', () => {
  assert.equal(isWholeFileDeletion('sysRun', { command: 'sed -i s/old/new/ app.ts' }), false);
  assert.equal(isWholeFileDeletion('sysRun', { command: 'echo "rm old.ts"' }), false);
  assert.equal(isWholeFileDeletion('gitOp', { command: 'rm --cached app.ts' }), false);
  assert.equal(needsApproval('C', 'fs_edit', { path: 'app.ts', oldText: 'old', newText: 'new' }, 'dangerous'), false);
});

test('Modes A and B keep their supervised approval rules', () => {
  assert.equal(needsApproval('A', 'fs_edit', { path: 'app.ts' }, 'moderate'), true);
  assert.equal(needsApproval('B', 'fs_edit', { path: 'app.ts' }, 'moderate'), false);
  assert.equal(needsApproval('B', 'sysRun', { command: 'chmod 600 app.ts' }, 'dangerous'), true);
  assert.equal(needsApproval('B', 'sysRun', { command: 'chmod 600 app.ts' }, 'dangerous', true), false);
});

test('tool-local consent checks use only the live session mode', () => {
  assert.equal(isAutonomousToolContext({ parentLoop: { config: { autonomyMode: 'C' } } }), true);
  assert.equal(isAutonomousToolContext({ parentLoop: { config: {} } }), true);
  assert.equal(isAutonomousToolContext({ parentLoop: { config: { autonomyMode: 'B' } } }), false);
  assert.equal(isAutonomousToolContext({ confirm: true }), false);
  assert.equal(isAutonomousToolContext({}), false);
});

test('legacy tool autonomy is scoped to each async invocation', async () => {
  assert.equal(currentToolAutonomyMode(), undefined);
  const modes = await Promise.all([
    withToolAutonomyMode('C', async () => {
      await Promise.resolve();
      return currentToolAutonomyMode();
    }),
    withToolAutonomyMode('B', async () => {
      await Promise.resolve();
      return currentToolAutonomyMode();
    })
  ]);
  assert.deepEqual(modes, ['C', 'B']);
  assert.equal(currentToolAutonomyMode(), undefined);
});

test('git operations retain supervised risk classification', () => {
  const sandbox = new Sandbox({ workspaceRoot: process.cwd() });
  assert.equal(sandbox.validate('gitOp', { command: 'status' }).risk, 'safe');
  assert.equal(sandbox.validate('gitOp', { command: 'push --force origin main' }).risk, 'dangerous');
  assert.equal(sandbox.validate('gitOp', { command: 'branch -D old' }).risk, 'dangerous');
  assert.equal(isWholeFileDeletion('gitOp', { command: 'rm old.ts' }), true);
});

test('AgentLoop Mode C executes an extreme ordinary tool without an approval request', async () => {
  const previousDirectory = process.cwd();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-autonomy-'));
  fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
  process.chdir(workspace);
  const toolName = 'mode_c_probe';
  let executions = 0;
  let approvalWaits = 0;
  let systemPolicySeen = false;
  const events: Array<{ type: string }> = [];
  toolRegistry[toolName] = {
    schema: { name: toolName, description: 'Test probe', parameters: { type: 'object', properties: {} } },
    execute: async () => { executions += 1; return { success: true, output: 'observed' }; }
  };

  try {
    const loop = new AgentLoop({ readyState: 1, send: (payload: string) => events.push(JSON.parse(payload)) },
      'mode-c-probe', 'inspect the workspace');
    loop.setAutonomyMode('C');
    loop.sandbox.validate = () => ({ allowed: true, risk: 'extreme' });
    loop.waitForApproval = async () => { approvalWaits += 1; return true; };
    let calls = 0;
    const model = {
      supportsVision: false,
      supportsToolSearch: () => false,
      chat: async (messages: Array<{ role: string; content: string }>) => {
        systemPolicySeen ||= messages.some((message) => message.role === 'system'
          && message.content.includes(AGENT_USER_POLICY));
        calls += 1;
        return calls === 1
          ? { content: '', toolCalls: [{ id: 'probe-1', type: 'function',
            function: { name: toolName, arguments: '{}' } }],
            usage: { promptTokens: 10, completionTokens: 8 } }
          : { content: 'The probe returned an observed result.', usage: { promptTokens: 10, completionTokens: 8 } };
      }
    };
    loop.initializeProvider = () => model as never;

    await loop.run();

    assert.equal(executions, 1);
    assert.equal(approvalWaits, 0);
    assert.equal(systemPolicySeen, true);
    assert.equal(events.some((event) => event.type === 'approval_request'), false);
  } finally {
    delete toolRegistry[toolName];
    process.chdir(previousDirectory);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
