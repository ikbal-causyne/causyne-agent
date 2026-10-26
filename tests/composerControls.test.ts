import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { availableModelVariants } from '../src/tui/composerControls.js';
import { ChatPrompt } from '../src/tui/prompt.js';
import { CodeStreamRenderer } from '../src/tui/codeStreamRenderer.js';
import { Transcript } from '../src/tui/transcript.js';
import { AcpProvider } from '../src/providers/acp.js';
import { AgentLoop } from '../src/agentLoop.js';

test('variant choices follow the active provider catalogue', () => {
  const variants = availableModelVariants({ provider: 'antigravity', model: 'Gemini 3.8 Flash (High)' });
  assert.deepEqual(variants, [
    'Gemini 3.8 Flash (Low)',
    'Gemini 3.8 Flash (Medium)',
    'Gemini 3.8 Flash (High)'
  ]);
  assert.deepEqual(availableModelVariants({ provider: 'acp/cursor', model: 'cursor' }), []);
});

test('composer shortcuts open controls without modifying the draft', async () => {
  const opened: string[] = [];
  const out = { columns: 120, rows: 40, write: () => true };
  const input = { isTTY: true };
  const prompt = new ChatPrompt({
    out,
    input,
    onOpenMode: () => { opened.push('mode'); },
    onOpenModel: () => { opened.push('model'); },
    onOpenVariant: () => { opened.push('variant'); }
  });
  prompt.editor.setText('preserve this draft');
  prompt.handleKey({ name: 'g', ctrl: true });
  prompt.handleKey({ name: 'm', alt: true });
  prompt.handleKey({ name: 't', ctrl: true });
  await Promise.resolve();
  assert.deepEqual(opened, ['mode', 'model', 'variant']);
  assert.equal(prompt.editor.getText(), 'preserve this draft');
});

test('repeated Esc and Ctrl+C while busy commit interrupted once, preserve interrupting status, and allow double Ctrl+C exit', () => {
  let interruptCount = 0;
  let exitCount = 0;
  const committed: string[] = [];
  const transcript = new Transcript();
  const out = { columns: 120, rows: 40, isTTY: true, write: () => true };
  const input = { isTTY: true };
  const renderer = new CodeStreamRenderer({ out, transcript, quietStatus: true });
  const surface = {
    width: 120,
    commit(kind: string, produce: (width: number) => string[]) {
      transcript.append({ kind, produce });
      committed.push(produce(120).join('\n'));
    },
    present() {},
    composeWidth: () => 100
  };

  const prompt = new ChatPrompt({
    out,
    input,
    surface,
    onInterrupt: () => { interruptCount++; },
    onExit: () => { exitCount++; }
  });
  prompt.attach(renderer);
  prompt.setBusy(true);
  prompt.queue.push('queued message that should be cleared on interrupt');

  // Stream initial reasoning frame
  renderer.handle({
    type: 'agent_reasoning',
    content: 'Initial reasoning line 1\nInitial reasoning line 2',
    streaming: true,
    elapsedMs: 500
  });

  // Press Esc 20 times in a row while busy
  for (let i = 0; i < 20; i++) {
    prompt.handleKey({ name: 'escape' });
  }

  assert.equal(committed.length, 1, 'must commit "× interrupted" at most once per turn');
  assert.match(committed[0] || '', /interrupted/);
  assert.equal(prompt.queue.length, 0, 'interrupting a turn must clear queued follow-up messages');
  assert.equal(prompt.statusMessage, 'interrupting…');
  assert.equal(interruptCount, 20);
  assert.equal(exitCount, 0);

  // Late status updates from renderer while still busy & interrupted must not overwrite 'interrupting…'
  renderer.onStatusChange?.('Thinking…');
  assert.equal(prompt.statusMessage, 'interrupting…');

  // Even if a late reasoning chunk arrives after "× interrupted", it must not overwrite the interrupted notice frame
  renderer.handle({
    type: 'agent_reasoning',
    content: 'Late reasoning after interrupt',
    streaming: true,
    elapsedMs: 600
  });
  const noticeFrames = transcript.frames.filter((f: { kind: string }) => f.kind === 'notice');
  assert.equal(noticeFrames.length, 1, 'the interrupted notice frame must not be overwritten by updateTailFrame');

  // Pressing Ctrl+C once while already interrupted records lastCtrlC without adding a second interrupted line
  prompt.handleKey({ name: 'c', ctrl: true });
  assert.equal(committed.length, 1, 'Ctrl+C after Esc must not duplicate "× interrupted"');
  assert.equal(exitCount, 0);

  // Pressing Ctrl+C a second time within the window while still busy force-exits so the user is never trapped
  prompt.handleKey({ name: 'c', ctrl: true });
  assert.equal(exitCount, 1, 'double Ctrl+C while busy must force exit');

  // Resetting busy state clears interruptedTurn and statusMessage
  prompt.setBusy(false);
  assert.equal(prompt.interruptedTurn, false);
  assert.equal(prompt.statusMessage, '');
});

test('AcpProvider aborts in-flight prompt immediately on AbortSignal without respawning a second peer session', async () => {
  // Spawn a minimal inline Node script that acts as an ACP peer hanging on session/prompt
  const peerScript = `
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'mock-acp', version: '1.0.0' } }
          }) + '\\n');
        } else if (msg.method === 'session/new') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { sessionId: 'sess_1' }
          }) + '\\n');
        } else if (msg.method === 'session/set_model') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {}
          }) + '\\n');
        } else if (msg.method === 'session/prompt') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess_1',
              update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking forever...' } }
            }
          }) + '\\n');
          // Deliberately never resolve session/prompt until killed/cancelled
        }
      }
    });
  `;

  const provider = new AcpProvider({
    provider: 'acp/opencode',
    command: process.execPath,
    args: ['-e', peerScript]
  });

  let startCalls = 0;
  const origGetOrCreate = (provider as any).getOrCreateClient.bind(provider);
  (provider as any).getOrCreateClient = async (signal?: AbortSignal) => {
    startCalls++;
    return origGetOrCreate(signal);
  };

  const controller = new AbortController();
  const reasoningChunks: string[] = [];
  let abortStartedAt = 0;

  const chatPromise = provider.chat(
    [{ role: 'user', content: 'test abort' }],
    {
      signal: controller.signal,
      onReasoningChunk: (chunk) => {
        reasoningChunks.push(chunk);
        // Abort as soon as the first reasoning chunk arrives
        abortStartedAt = Date.now();
        controller.abort();
      }
    }
  );

  await assert.rejects(
    chatPromise,
    (err: any) => err?.name === 'AbortError'
  );
  const abortLatencyMs = Date.now() - abortStartedAt;

  assert.equal(startCalls, 1, 'AcpProvider must NOT respawn a second client on user abort');
  assert.ok(abortStartedAt > 0, 'reasoning chunk must have triggered abort');
  assert.ok(abortLatencyMs < 500, `AcpProvider abort latency took too long (${abortLatencyMs}ms)`);
});

test('AgentLoop exits cleanly without error frames or retries when aborted during llm.chat', async () => {
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  const conn = {
    readyState: 1,
    send(payload: string) {
      events.push(JSON.parse(payload));
    }
  };

  const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-abort-loop-'));
  const loop = new AgentLoop(conn, 'test_abort_loop', 'explain quantum computing', {
    workspaceRoot: tempWorkspace
  });
  loop.llm = {
    supportsVision: false,
    supportsAudio: false,
    supportsToolSearch: () => false,
    chat: async (_messages: unknown[], options: { signal?: AbortSignal; onReasoningChunk?: (c: string) => void }) => {
      options.onReasoningChunk?.('Starting deep reasoning...');
      return await new Promise((_resolve, reject) => {
        const onAbort = () => {
          const err = new Error('ACP request aborted by user');
          err.name = 'AbortError';
          reject(err);
        };
        if (options.signal?.aborted) {
          onAbort();
          return;
        }
        options.signal?.addEventListener('abort', onAbort, { once: true });
        setTimeout(() => loop.abort(), 30);
      });
    }
  };
  loop.initializeProvider = () => loop.llm as never;

  await loop.run();

  const errorEvents = events.filter(e => e.type === 'error' || e.type === 'step_error');
  assert.deepEqual(errorEvents, [], 'user abort must not emit error or step_error retry frames');
});
