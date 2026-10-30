import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { AcpClient } from '../src/acp/client.js';
import { AcpProvider } from '../src/providers/acp.js';

type PromptBlock = { type: string; text?: string };

test('ACP keeps one workspace-scoped peer and sends only new context and tool results', async () => {
  const original = {
    start: AcpClient.prototype.start,
    newSession: AcpClient.prototype.newSession,
    getSessionModels: AcpClient.prototype.getSessionModels,
    setSessionModel: AcpClient.prototype.setSessionModel,
    prompt: AcpClient.prototype.prompt,
    close: AcpClient.prototype.close
  };
  const workspaces: string[] = [];
  const prompts: PromptBlock[][] = [];
  let sessionCount = 0;
  let failNext = false;
  AcpClient.prototype.start = async () => undefined as never;
  AcpClient.prototype.newSession = async (_cwd: string) => {
    workspaces.push(_cwd);
    return `session-${++sessionCount}`;
  };
  AcpClient.prototype.getSessionModels = () => ({ availableModels: [], modelLabels: {}, usesConfigOption: false });
  AcpClient.prototype.setSessionModel = async () => undefined;
  AcpClient.prototype.prompt = async (_sessionId: string, blocks: PromptBlock[]) => {
    prompts.push(blocks);
    if (failNext) {
      failNext = false;
      throw new Error('connection lost');
    }
    return { text: '<tool_call>{"name":"fs_read","arguments":{"path":"a.txt"}}</tool_call>', stopReason: 'end_turn' };
  };
  AcpClient.prototype.close = async () => undefined;

  const provider = new AcpProvider({ provider: 'acp/test-peer', command: 'unused', args: [] });
  const tools = [{ name: 'fs_read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
  const workspaceRoot = path.resolve('/tmp/causyne-acp-selected-workspace');
  const anotherWorkspace = path.resolve('/tmp/another-workspace');
  const base = [
    { role: 'system', content: 'Stable system guidance' },
    { role: 'system', content: 'Current mode B' },
    { role: 'user', content: 'Read a.txt' }
  ];
  const opts = { conversationId: 'task-1', workspaceRoot, tools };
  const text = (index: number) => prompts[index]!.filter(block => block.type === 'text').map(block => block.text).join('\n');
  try {
    const first = await provider.chat(base, opts);
    assert.equal(workspaces[0], workspaceRoot);
    assert.match(text(0), /Read a\.txt/);
    assert.match(text(0), /Current Available Tools/);

    const assistant = { role: 'assistant', content: '', tool_calls: first.toolCalls };
    const toolResult = { role: 'tool', name: 'fs_read', content: 'File contents: one' };
    await provider.chat([...base, assistant, toolResult], opts);
    assert.equal(sessionCount, 1);
    assert.match(text(1), /File contents: one/);
    assert.doesNotMatch(text(1), /Read a\.txt|Current Available Tools|Stable system guidance/);
    assert.doesNotMatch(text(1), /<tool_call>/);

    // Identical observations can come from separate real tool calls. Do not
    // silently drop either one while compressing the transport transcript.
    const repeated = provider.formatPromptBlocks([
      { role: 'tool', name: 'fs_read', content: 'same observation' },
      { role: 'tool', name: 'fs_read', content: 'same observation' }
    ], [], false).filter(block => block.type === 'text').map(block => block.text).join('\n');
    assert.equal(repeated.match(/same observation/g)?.length, 2);

    // An evolving system tail is sent once, without replaying earlier context.
    const updated = [base[0], { role: 'system', content: 'Current mode C' }, base[2], assistant, toolResult];
    await provider.chat(updated, opts);
    assert.equal(sessionCount, 1);
    assert.match(text(2), /Current mode C/);
    assert.doesNotMatch(text(2), /Read a\.txt|File contents: one/);

    // In-place compaction of historical tool observations does NOT tear down the stateful ACP session.
    const compactedToolResult = { role: 'tool', name: 'fs_read', content: 'File contents: [truncated]' };
    const compacted = [base[0], updated[1], base[2], assistant, compactedToolResult, { role: 'tool', name: 'fs_read', content: 'File contents: two' }];
    await provider.chat(compacted, opts);
    assert.equal(sessionCount, 1);
    assert.match(text(3), /File contents: two/);
    assert.doesNotMatch(text(3), /File contents: \[truncated\]/);

    // A dropped/edited transcript cannot safely be treated as an append-only delta.
    const revised = [base[0], updated[1], { role: 'user', content: 'Read b.txt instead' }];
    await provider.chat(revised, opts);
    assert.equal(sessionCount, 2);
    assert.match(text(4), /Read b\.txt instead/);
    assert.match(text(4), /Current Available Tools/);

    await provider.chat(revised, { ...opts, conversationId: 'task-2', workspaceRoot: anotherWorkspace });
    assert.equal(sessionCount, 3);
    assert.equal(workspaces[2], anotherWorkspace);

    // A broken peer is restarted with the full context, never a delta alone.
    failNext = true;
    await provider.chat([...revised, { role: 'tool', name: 'fs_read', content: 'Repeated result' }], {
      ...opts, conversationId: 'task-2', workspaceRoot: anotherWorkspace
    });
    assert.equal(sessionCount, 4);
    assert.match(text(7), /Read b\.txt instead/);
    assert.match(text(7), /Current Available Tools/);
  } finally {
    await provider.close();
    Object.assign(AcpClient.prototype, original);
  }
});
