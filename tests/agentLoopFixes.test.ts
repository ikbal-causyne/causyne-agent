import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../src/agentLoop.js';
import { resolveTool } from '../src/tools/registry.js';

function createTempWorkspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeTestLoop(workspace: string, prompt: string, taskId: string, events: Array<Record<string, unknown>> = []): AgentLoop {
  const loop = new AgentLoop(
    { readyState: 1, send: (payload: string) => events.push(JSON.parse(payload) as Record<string, unknown>) },
    taskId,
    prompt,
    { workspaceRoot: workspace }
  );
  loop.messages = [];
  loop.memoryManager = { saveHistory: () => {}, loadHistory: () => [] };
  loop.config.autonomyMode = 'C';
  return loop;
}

test('AgentLoop keeps multi-tool batch tool results contiguous before image user message and runtime error diagnostics', async () => {
  const workspace = createTempWorkspace('causyne-loop-batch-');
  const screenshotTool = resolveTool('screenshot');
  const readTool = resolveTool('fs_read');
  const browserTool = resolveTool('browser_act');
  const origScreenshot = screenshotTool.execute;
  const origRead = readTool.execute;
  const origBrowser = browserTool.execute;

  const targetFile = path.join(workspace, 'note.txt');
  const htmlFile = path.join(workspace, 'index.html');
  fs.writeFileSync(targetFile, 'hello world');
  fs.writeFileSync(htmlFile, '<html><body>ok</body></html>');

  screenshotTool.execute = async () => ({
    success: true,
    _is_image_marker: true,
    filename: 'screen.png',
    mimeType: 'image/png',
    base64: Buffer.from('fake-png-bytes').toString('base64')
  });
  readTool.execute = async () => ({ success: true, output: 'hello world' });
  browserTool.execute = async () => ({
    success: true,
    data: [{ action: 'preview', data: { runtimeErrors: ['ReferenceError: foo is not defined'] } }]
  });

  try {
    const loop = makeTestLoop(workspace, 'Inspect note.txt', 'batch-order-1');
    const seenMessagesOnTurn2: Array<Record<string, unknown>> = [];
    const seenMessagesOnTurn3: Array<Record<string, unknown>> = [];
    let turn = 0;
    loop.initializeProvider = () => ({
      supportsVision: true,
      imagePayloadFormat: 'openai',
      supportsToolSearch: () => false,
      chat: async (messages: Array<Record<string, unknown>>) => {
        turn++;
        if (turn === 1) {
          return {
            content: '',
            toolCalls: [
              { id: 'call_img', type: 'function', function: { name: 'screenshot', arguments: '{}' } },
              { id: 'call_read', type: 'function', function: { name: 'fs_read', arguments: JSON.stringify({ path: targetFile }) } }
            ],
            usage: { promptTokens: 10, completionTokens: 10 }
          };
        }
        if (turn === 2) {
          seenMessagesOnTurn2.push(...messages);
          return {
            content: '',
            toolCalls: [
              { id: 'call_browser', type: 'function', function: { name: 'browser_act', arguments: JSON.stringify({ actions: [{ type: 'preview', filePath: 'index.html' }] }) } }
            ],
            usage: { promptTokens: 10, completionTokens: 10 }
          };
        }
        if (turn === 3) {
          seenMessagesOnTurn3.push(...messages);
          loop.abort();
        }
        return { content: 'Inspection finished cleanly after checking everything.', toolCalls: [], usage: { promptTokens: 10, completionTokens: 10 } };
      }
    }) as never;

    await loop.run();
    assert.equal(turn, 3);

    const t2ImgIdx = seenMessagesOnTurn2.findIndex((m) => m.role === 'tool' && m.tool_call_id === 'call_img');
    const t2ReadIdx = seenMessagesOnTurn2.findIndex((m) => m.role === 'tool' && m.tool_call_id === 'call_read');
    const t2UserImgIdx = seenMessagesOnTurn2.findIndex((m) => m.role === 'user' && Array.isArray(m.content));
    assert.ok(t2ImgIdx !== -1 && t2ReadIdx !== -1, 'both call_img and call_read tool results must survive sanitizeSequences');
    assert.ok(t2ImgIdx < t2ReadIdx && t2ReadIdx < t2UserImgIdx, 'all tool results must precede the deferred image user message');

    const t3BrowserToolIdx = seenMessagesOnTurn3.findIndex((m) => m.role === 'tool' && m.tool_call_id === 'call_browser');
    const t3RuntimeErrIdx = seenMessagesOnTurn3.findIndex(
      (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('BROWSER RUNTIME ERRORS DETECTED')
    );
    assert.ok(t3BrowserToolIdx !== -1, 'browser_act tool result must survive sanitizeSequences');
    assert.ok(t3RuntimeErrIdx > t3BrowserToolIdx, 'runtime error diagnostic must follow the browser_act tool result');
  } finally {
    screenshotTool.execute = origScreenshot;
    readTool.execute = origRead;
    browserTool.execute = origBrowser;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('AgentLoop places authoring action mandate after the inspection tool result so sanitizeSequences retains it', async () => {
  const workspace = createTempWorkspace('causyne-loop-mandate-');
  const readTool = resolveTool('fs_read');
  const origRead = readTool.execute;
  const f1 = path.join(workspace, 'a.txt');
  const f2 = path.join(workspace, 'b.txt');
  const f3 = path.join(workspace, 'c.txt');
  const f4 = path.join(workspace, 'd.txt');
  fs.writeFileSync(f1, 'a');
  fs.writeFileSync(f2, 'b');
  fs.writeFileSync(f3, 'c');
  fs.writeFileSync(f4, 'd');

  readTool.execute = async (args: { path?: string }) => ({ success: true, output: String(args.path || '') });

  try {
    const loop = makeTestLoop(workspace, 'Create a TypeScript utility module in the workspace', 'mandate-order-1');
    const seenOnTurn5: Array<Record<string, unknown>> = [];
    let turn = 0;
    loop.initializeProvider = () => ({
      supportsVision: false,
      supportsToolSearch: () => false,
      chat: async (messages: Array<Record<string, unknown>>) => {
        turn++;
        if (turn === 1) {
          return { content: '', toolCalls: [{ id: 'r1', type: 'function', function: { name: 'fs_read', arguments: JSON.stringify({ path: f1 }) } }], usage: { promptTokens: 5, completionTokens: 5 } };
        }
        if (turn === 2) {
          return { content: '', toolCalls: [{ id: 'r2', type: 'function', function: { name: 'fs_read', arguments: JSON.stringify({ path: f2 }) } }], usage: { promptTokens: 5, completionTokens: 5 } };
        }
        if (turn === 3) {
          return { content: '', toolCalls: [{ id: 'r3', type: 'function', function: { name: 'fs_read', arguments: JSON.stringify({ path: f3 }) } }], usage: { promptTokens: 5, completionTokens: 5 } };
        }
        if (turn === 4) {
          return { content: '', toolCalls: [{ id: 'r4', type: 'function', function: { name: 'fs_read', arguments: JSON.stringify({ path: f4 }) } }], usage: { promptTokens: 5, completionTokens: 5 } };
        }
        seenOnTurn5.push(...messages);
        loop.abort();
        return { content: '', usage: { promptTokens: 5, completionTokens: 5 } };
      }
    }) as never;

    await loop.run();
    const r4Idx = seenOnTurn5.findIndex((m) => m.role === 'tool' && m.tool_call_id === 'r4');
    const mandateIdx = seenOnTurn5.findIndex(
      (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('CRITICAL ACTION MANDATE')
    );
    assert.ok(r4Idx !== -1, '4th inspection tool result must NOT be stripped by sanitizeSequences');
    assert.ok(mandateIdx > r4Idx, 'CRITICAL ACTION MANDATE system notice must follow tool result r4');
  } finally {
    readTool.execute = origRead;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('AgentLoop handles tool-level AbortError without task abort as a recoverable tool failure', async () => {
  const workspace = createTempWorkspace('causyne-loop-tool-abort-');
  const readTool = resolveTool('fs_read');
  const origRead = readTool.execute;
  const f1 = path.join(workspace, 'one.txt');
  const f2 = path.join(workspace, 'two.txt');
  fs.writeFileSync(f1, 'one');
  fs.writeFileSync(f2, 'two');

  let f1Attempts = 0;
  let f2Attempts = 0;
  readTool.execute = async (args: { path?: string }) => {
    if (args.path === f1) {
      f1Attempts++;
      throw Object.assign(new Error('operation timed out'), { name: 'AbortError' });
    }
    f2Attempts++;
    return { success: true, output: 'two' };
  };

  try {
    const loop = makeTestLoop(workspace, 'Read two.txt', 'tool-abort-1');
    const seenOnTurn2: Array<Record<string, unknown>> = [];
    let turn = 0;
    loop.initializeProvider = () => ({
      supportsVision: false,
      supportsToolSearch: () => false,
      chat: async (messages: Array<Record<string, unknown>>) => {
        turn++;
        if (turn === 1) {
          return {
            content: '',
            toolCalls: [
              { id: 'timeout_1', type: 'function', function: { name: 'fs_read', arguments: JSON.stringify({ path: f1 }) } },
              { id: 'ok_2', type: 'function', function: { name: 'fs_read', arguments: JSON.stringify({ path: f2 }) } }
            ],
            usage: { promptTokens: 5, completionTokens: 5 }
          };
        }
        seenOnTurn2.push(...messages);
        return { content: 'Handled the tool timeout and completed reading two.txt.', toolCalls: [], usage: { promptTokens: 5, completionTokens: 5 } };
      }
    }) as never;

    await loop.run();
    assert.ok(f1Attempts >= 1, 'timed-out tool must have attempted execution');
    assert.equal(f2Attempts, 1, 'second tool in batch must still execute once when first throws tool-local AbortError');
    const firstResult = seenOnTurn2.find((m) => m.role === 'tool' && m.tool_call_id === 'timeout_1');
    const secondResult = seenOnTurn2.find((m) => m.role === 'tool' && m.tool_call_id === 'ok_2');
    assert.ok(firstResult && typeof firstResult.content === 'string' && !firstResult.content.includes('TOOL_OUTCOME_UNRECORDED'));
    assert.match(String(firstResult.content), /operation timed out/);
    assert.ok(secondResult && String(secondResult.content).includes('two'));
  } finally {
    readTool.execute = origRead;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('AgentLoop does not double-count stepsCompleted when RetryConsentCheckpoint fires on native actions', async () => {
  const workspace = createTempWorkspace('causyne-loop-steps-');
  try {
    const loop = makeTestLoop(workspace, 'Run tests', 'steps-count-1');
    loop.waitForDecision = async () => ({ optionId: 'stop', label: 'Stop' });
    loop.initializeProvider = () => ({
      supportsVision: false,
      supportsToolSearch: () => false,
      chat: async (_messages: unknown[], options: { onNativeAction: (a: unknown) => void }) => {
        options.onNativeAction({ id: 'n1', name: 'fs_read', status: 'completed', detail: 'a.ts' });
        options.onNativeAction({ id: 'n2', name: 'fs_read', status: 'completed', detail: 'b.ts' });
        options.onNativeAction({ id: 'f1', name: 'bash', status: 'failed', parameters: { command: 'npm test' }, detail: 'fail' });
        options.onNativeAction({ id: 'f2', name: 'bash', status: 'failed', parameters: { command: 'npm test' }, detail: 'fail' });
        options.onNativeAction({ id: 'f3', name: 'bash', status: 'failed', parameters: { command: 'npm test' }, detail: 'fail' });
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
    }) as never;

    await loop.run();
    assert.equal(loop.stepsCompleted, 2);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('AgentLoop records completed tool result when Mode B tier extension is declined', async () => {
  const workspace = createTempWorkspace('causyne-loop-tier-');
  const readTool = resolveTool('fs_read');
  const origRead = readTool.execute;
  const f1 = path.join(workspace, 'data.txt');
  fs.writeFileSync(f1, 'verified data');
  readTool.execute = async () => ({ success: true, output: 'verified data' });

  try {
    const loop = makeTestLoop(workspace, 'Read data.txt', 'tier-decline-1');
    loop.config.autonomyMode = 'B';
    loop.maxStepsCeiling = 1;
    let askedToolCallId = '';
    loop.waitForApproval = async (toolCallId: string) => {
      askedToolCallId = toolCallId;
      return false;
    };
    loop.initializeProvider = () => ({
      supportsVision: false,
      supportsToolSearch: () => false,
      chat: async () => ({
        content: '',
        toolCalls: [{ id: 'read_before_limit', type: 'function', function: { name: 'fs_read', arguments: JSON.stringify({ path: f1 }) } }],
        usage: { promptTokens: 5, completionTokens: 5 }
      })
    }) as never;

    await loop.run();
    assert.match(askedToolCallId, /^tier_extension_/);
    const recorded = loop.messages.find((m: { role: string; tool_call_id?: string }) => m.role === 'tool' && m.tool_call_id === 'read_before_limit');
    assert.ok(recorded, 'already-executed tool result must be saved before stopping');
    assert.match(String(recorded.content), /verified data/);
    assert.equal(String(recorded.content).includes('TOOL_OUTCOME_UNRECORDED'), false);
  } finally {
    readTool.execute = origRead;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('AgentLoop resets per-task failure/nudge counters on reuse, guards aborted requestDecision, detects Android context, and hardens classifyError', async () => {
  const workspace = createTempWorkspace('causyne-loop-reuse-');
  try {
    const loop = makeTestLoop(workspace, 'Debug Android Gradle APK build', 'reuse-1');
    assert.equal(loop.classifyError(null), 'unknown_error');
    assert.equal(loop.classifyError('ECONNRESET while connecting'), 'network_error');

    const staticCtx = await loop.buildStaticContext();
    assert.match(staticCtx.universalSkillsContext, /android/i);

    // Late decision arrival after abort must be ignored cleanly.
    let resolveDecision!: (v: unknown) => void;
    loop.waitForDecision = async () => new Promise((resolve) => { resolveDecision = resolve; });
    const pendingDecision = loop.requestDecision({
      id: 'dec-1',
      kind: 'architecture',
      question: 'Pick?',
      options: [{ id: 'a', label: 'Option A' }]
    });
    loop.abort();
    resolveDecision({ optionId: 'a', label: 'Option A' });
    assert.equal(await pendingDecision, null);
    assert.equal(loop._decisionAnswers.size, 0);

    // Simulate dirty counters from an earlier turn, then run a fresh turn.
    loop.consecutiveFailures = 2;
    loop.lastFailureType = 'network_error';
    loop._nonMutationNudges = 2;
    loop.userPrompt = 'Respond with OK.';
    loop.initializeProvider = () => ({
      supportsVision: false,
      supportsToolSearch: () => false,
      chat: async () => ({ content: 'All checks acknowledged.', toolCalls: [], usage: { promptTokens: 5, completionTokens: 5 } })
    }) as never;

    await loop.run();
    assert.equal(loop.consecutiveFailures, 0);
    assert.equal(loop.lastFailureType, null);
    assert.equal(loop._nonMutationNudges, 0);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
