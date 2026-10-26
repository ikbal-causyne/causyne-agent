import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop, isMidTaskProgressText } from '../src/agentLoop.js';
import { AntigravityProvider } from '../src/providers/antigravity.js';
import { CodeStreamRenderer } from '../src/tui/codeStreamRenderer.js';

test('an actionable request fails visibly after repeated greetings without showing them as answers', async () => {
  const previousDirectory = process.cwd();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-greeting-'));
  fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
  process.chdir(workspace);

  try {
    const events: Array<{ type: string; message?: string }> = [];
    const loop = new AgentLoop({ readyState: 1, send: (payload: string) => events.push(JSON.parse(payload)) }, 'greeting-regression', 'create a 3js shooting game');
    let calls = 0;
    const model = {
      supportsVision: false,
      supportsToolSearch: () => false,
      chat: async () => {
        calls += 1;
        return { content: 'Hello! How can I help you today?', usage: { promptTokens: 10, completionTokens: 8 } };
      }
    };
    loop.initializeProvider = () => model as never;

    await loop.run();

    assert.equal(calls, 3);
    assert.equal(events.some((event) => event.type === 'agent_message'), false);
    assert.equal(events.some((event) => event.type === 'error' && event.message?.includes('No work was completed')), true);
    assert.equal(events.some((event) => event.type === 'task_complete'), false);
    assert.equal(loop.unlockedPacks.has('game'), false);
  } finally {
    process.chdir(previousDirectory);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('planning-only responses cannot report an unstarted task as complete', async () => {
  const previousDirectory = process.cwd();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-no-progress-'));
  fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
  process.chdir(workspace);

  try {
    const events: Array<{ type: string; message?: string }> = [];
    const loop = new AgentLoop({ readyState: 1, send: (payload: string) => events.push(JSON.parse(payload)) }, 'planning-regression', 'create a 3js shooting game');
    const model = {
      supportsVision: false,
      supportsToolSearch: () => false,
      chat: async () => ({ content: 'I will create the game next.', usage: { promptTokens: 10, completionTokens: 8 } })
    };
    loop.initializeProvider = () => model as never;

    await loop.run();

    assert.equal(events.some((event) => event.type === 'agent_message'), false);
    assert.equal(events.some((event) => event.type === 'error' && event.message?.includes('No work was completed')), true);
    assert.equal(events.some((event) => event.type === 'status' && event.message === 'Task completed.'), false);
    assert.equal(events.some((event) => event.type === 'task_complete'), false);
  } finally {
    process.chdir(previousDirectory);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('isMidTaskProgressText identifies intermediate progress announcements and ignores completed answers', () => {
  assert.equal(
    isMidTaskProgressText('Real assets verified. Writing the Tesla-style redesign now.'),
    true
  );
  assert.equal(
    isMidTaskProgressText(
      'Let me look at the newer assets to know what they actually show.\nOfficial Tesla channel videos found. Pulling their real stills and confirming embeddability.'
    ),
    true
  );
  assert.equal(
    isMidTaskProgressText('Checking the build output and updating styles next.'),
    true
  );
  assert.equal(
    isMidTaskProgressText('Created cake.html and verified the layout in the workspace.'),
    false
  );
  assert.equal(
    isMidTaskProgressText('Everything is complete. Let me know if you want any adjustments!'),
    false
  );
});

test('AgentLoop auto-continues when provider returns externalActions with mid-task progress or incompleteTurn', async () => {
  const previousDirectory = process.cwd();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-midtask-continue-'));
  fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
  process.chdir(workspace);

  try {
    const events: Array<{ type: string; content?: string; message?: string }> = [];
    const loop = new AgentLoop(
      { readyState: 1, send: (payload: string) => events.push(JSON.parse(payload)) },
      'midtask-regression',
      'redesign the roadster page',
      { workspaceRoot: workspace }
    );
    let calls = 0;
    const model = {
      supportsVision: false,
      supportsToolSearch: () => false,
      chat: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            content: 'Real assets verified. Writing the Tesla-style redesign now.',
            externalActions: [
              { name: 'read_file', status: 'completed', detail: 'hero.jpg' },
              { name: 'run_command', status: 'completed', detail: 'ls -la' }
            ],
            usage: { promptTokens: 20, completionTokens: 12 }
          };
        }
        if (calls === 2) {
          return {
            content:
              'Let me look at the newer assets to know what they actually show.\nOfficial Tesla channel videos found. Pulling their real stills and confirming embeddability.',
            externalActions: [
              { name: 'run_command', status: 'completed', detail: 'python3 sheet.py' }
            ],
            incompleteTurn: true,
            usage: { promptTokens: 25, completionTokens: 18 }
          };
        }
        return {
          content: 'Redesigned index.html and verified all Roadster assets.',
          externalActions: [
            { name: 'write_file', status: 'completed', detail: 'index.html' }
          ],
          usage: { promptTokens: 30, completionTokens: 15 }
        };
      }
    };
    loop.initializeProvider = () => model as never;
    loop.llm = model as never;

    await loop.run();

    assert.equal(calls, 3, 'loop must continue across mid-task progress and incompleteTurn until the final completion turn');
    assert.equal(loop.stepsCompleted, 4, 'completed external actions must be counted in stepsCompleted');
    assert.equal(
      events.some((event) => event.type === 'agent_message' && event.content?.includes('Redesigned index.html')),
      true
    );
    assert.equal(events.some((event) => event.type === 'task_complete'), true);
  } finally {
    process.chdir(previousDirectory);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('AntigravityProvider detects incomplete print-timeout turns and preserves conversation across rotating taskIds in the same session', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-agy-midtask-'));
  const agy = path.join(dir, 'agy');
  const argsLog = path.join(dir, 'args.jsonl');
  fs.writeFileSync(
    agy,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args) + '\\n');
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const emit = (ev) => process.stdout.write(JSON.stringify(ev) + '\\n');
  const isResumed = args.includes('--conversation');
  emit({ event: 'init', conversation_id: 'conv-session-42' });
  if (!isResumed) {
    emit({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'Let me look at the newer assets.' } });
    emit({ event: 'step_update', step_update: { step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'python3 build_sheet.py' } } } });
    emit({ event: 'step_update', step_update: { step_type: 'tool', state: 'DONE', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'python3 build_sheet.py' } } } });
    process.stderr.write('[agy] print timeout after 300s with turn in progress; returning partial output\\n');
    emit({ event: 'result', result: { status: 'SUCCESS', conversation_id: 'conv-session-42', response: '', usage: { input_tokens: 10, output_tokens: 5 } } });
  } else {
    emit({ event: 'step_update', step_update: { step_type: 'tool', state: 'ACTIVE', tool_name: 'write_file', tool_info: { name: 'write_file', parameters: { Path: 'index.html' } } } });
    emit({ event: 'step_update', step_update: { step_type: 'tool', state: 'DONE', tool_name: 'write_file', tool_info: { name: 'write_file', parameters: { Path: 'index.html' } } } });
    emit({ event: 'result', result: { status: 'SUCCESS', conversation_id: 'conv-session-42', response: 'Completed index.html redesign.', usage: { input_tokens: 12, output_tokens: 8 } } });
  }
});
`,
    { mode: 0o755 }
  );

  try {
    const provider = new AntigravityProvider({ command: agy, model: 'Claude Opus 5.5 (High)' });
    const turn1 = await provider.chat([{ role: 'user', content: 'Redesign roadster' }], {
      taskId: 'cli_chat_1001',
      conversationId: 's_session_persist_1'
    });
    assert.equal(turn1.incompleteTurn, true, 'print-timeout mid-turn must be flagged as incompleteTurn');
    assert.equal(turn1.content, 'Let me look at the newer assets.');

    const turn2 = await provider.chat(
      [
        { role: 'user', content: 'Redesign roadster' },
        { role: 'assistant', content: turn1.content },
        { role: 'user', content: 'continue' }
      ],
      {
        taskId: 'cli_chat_1002',
        conversationId: 's_session_persist_1'
      }
    );
    assert.equal(turn2.incompleteTurn, undefined);
    assert.equal(turn2.content, 'Completed index.html redesign.');

    const loggedArgs = fs
      .readFileSync(argsLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(loggedArgs.length, 2);
    assert.equal(loggedArgs[0][loggedArgs[0].indexOf('--print-timeout') + 1], '1800s');
    assert.equal(loggedArgs[1].includes('--conversation'), true, 'second turn in same session must reuse --conversation even when taskId rotated');
    assert.equal(loggedArgs[1][loggedArgs[1].indexOf('--conversation') + 1], 'conv-session-42');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CodeStreamRenderer increments stepCount on nativeStep notice events', () => {
  const renderer = new CodeStreamRenderer({ out: { write: () => {}, columns: 100 } });
  renderer.resetTurn();
  assert.equal(renderer.stepCount, 0);
  renderer.handle({ type: 'notice', tone: 'muted', nativeStep: true, message: 'Antigravity read_file hero.jpg' });
  renderer.handle({ type: 'notice', tone: 'muted', nativeStep: true, message: 'Antigravity run_command ls' });
  renderer.handle({ type: 'notice', tone: 'muted', message: 'Context compacted' });
  assert.equal(renderer.stepCount, 2);
});
