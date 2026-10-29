import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AntigravityProvider, isAntigravityProvider, resolveAgyBinary, ANTIGRAVITY_MODELS } from '../src/providers/antigravity.js';
import { createProvider } from '../src/providers/factory.js';

function fakeAgy(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-agy-'));
  const command = path.join(dir, 'agy');
  fs.writeFileSync(command, script, { mode: 0o755 });
  return { dir, command };
}

describe('AntigravityProvider and isAntigravityProvider', () => {
  test('isAntigravityProvider recognizes antigravity and agy identifiers', () => {
    assert.strictEqual(isAntigravityProvider('antigravity'), true);
    assert.strictEqual(isAntigravityProvider('agy'), true);
    assert.strictEqual(isAntigravityProvider('antigravity/gemini'), true);
    assert.strictEqual(isAntigravityProvider('agy/argon'), true);

    assert.strictEqual(isAntigravityProvider('openai'), false);
    assert.strictEqual(isAntigravityProvider('anthropic'), false);
    assert.strictEqual(isAntigravityProvider('acp'), false);
    assert.strictEqual(isAntigravityProvider(''), false);
    assert.strictEqual(isAntigravityProvider(null), false);
    assert.strictEqual(isAntigravityProvider(undefined), false);
  });

  test('resolveAgyBinary returns a string path or agy command', () => {
    const bin = resolveAgyBinary();
    assert.ok(typeof bin === 'string' && bin.length > 0);
  });

  test('AntigravityProvider initializes with default Gemini 3.8 Flash (Low)', () => {
    const provider = new AntigravityProvider();
    assert.strictEqual(provider.model, 'Gemini 3.8 Flash (Low)');
    assert.ok(provider.command.includes('agy') || provider.command.includes('antigravity'));
  });

  test('ANTIGRAVITY_MODELS contains frontier models', () => {
    assert.ok(ANTIGRAVITY_MODELS.includes('Gemini 3.8 Flash (Low)'));
    assert.ok(ANTIGRAVITY_MODELS.includes('Gemini 4 Argon (Medium)'));
    assert.ok(ANTIGRAVITY_MODELS.includes('Claude Sonnet 5.5 (Medium)'));
  });

  test('formatConversation formats roles and tools cleanly', () => {
    const provider = new AntigravityProvider();
    const formatted = provider.formatConversation([
      { role: 'system', content: 'You are Antigravity.' },
      { role: 'user', content: 'Hello' }
    ], [{ name: 'fsRead' }]);

    assert.ok(formatted.includes('[Available Tools]'));
    assert.ok(formatted.includes('<tool_call>'));
    assert.ok(formatted.includes('[System Instructions]\nYou are Antigravity.'));
    assert.ok(formatted.includes('[User]\nHello'));
  });

  test('extractToolCalls parses XML tool_call blocks', () => {
    const provider = new AntigravityProvider();
    const sample = `Here is the tool call:
<tool_call>
{"name": "screenshot", "arguments": {}}
</tool_call>`;

    const calls = provider.extractToolCalls(sample);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].function.name, 'screenshot');

    const sampleParams = `<tool_call>{"name": "terminal_exec", "parameters": {"command": "ls -la"}}</tool_call>`;
    const callsParams = provider.extractToolCalls(sampleParams);
    assert.strictEqual(callsParams.length, 1);
    assert.strictEqual(callsParams[0].function.name, 'terminal_exec');
    assert.ok(callsParams[0].function.arguments.includes('ls -la'));

    const sampleFenced = "```tool_call\n{\"name\": \"file_read\", \"arguments\": {\"path\": \"test.txt\"}}\n```";
    const callsFenced = provider.extractToolCalls(sampleFenced);
    assert.strictEqual(callsFenced.length, 1);
    assert.strictEqual(callsFenced[0].function.name, 'file_read');
  });

  test('chat preserves native peer capabilities without forcing a profile or plan mode', { skip: process.platform === 'win32' }, async () => {
    const argsFile = path.join(os.tmpdir(), `causyne-agy-args-${process.pid}.json`);
    const stdinFile = path.join(os.tmpdir(), `causyne-agy-stdin-${process.pid}.txt`);
    process.env.AGY_ARGS_FILE = argsFile;
    process.env.AGY_STDIN_FILE = stdinFile;
    const fake = fakeAgy(`#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.AGY_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.AGY_STDIN_FILE, input);
  const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
  const message = JSON.parse(input.trim());
  emit({ event: 'init' });
  emit({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: message.event === 'user' && message.message.content.includes('[User]\\nping') ? 'pong' : 'Hello! How can I help?' } });
  emit({ event: 'result', result: { status: 'SUCCESS', response: message.event === 'user' && message.message.content.includes('[User]\\nping') ? 'pong' : 'Hello! How can I help?', usage: { input_tokens: 1, output_tokens: 1 } } });
});
`);
    try {
      const provider = new AntigravityProvider({ command: fake.command, model: 'Gemini 3.8 Flash (Low)' });
      const response = await provider.chat([{ role: 'user', content: 'ping' }]);
      assert.equal(response.content, 'pong');

      const args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
      assert.equal(args[args.indexOf('--input-format') + 1], 'stream-json');
      assert.ok(!args.includes('--agent'));
      assert.ok(!args.includes('--mode'));
      assert.ok(args.includes('--output-format'));
      assert.ok(!args.includes('--dangerously-skip-permissions'));
      assert.ok(!args.includes('--disable-slash-commands'));
      assert.ok(!args.includes('-p'));
      assert.ok(!args.includes('-'));

      const stdin = JSON.parse(fs.readFileSync(stdinFile, 'utf8'));
      assert.equal(stdin.event, 'user');
      assert.match(stdin.message.content, /\[User\]\nping/);
    } finally {
      delete process.env.AGY_ARGS_FILE;
      delete process.env.AGY_STDIN_FILE;
      fs.rmSync(fake.dir, { recursive: true, force: true });
      fs.rmSync(argsFile, { force: true });
      fs.rmSync(stdinFile, { force: true });
    }
  });

  test('an empty agy result is reported as a failure, not as a completed turn', { skip: process.platform === 'win32' }, async () => {
    const fake = fakeAgy(`#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '' } }) + '\\n');
});
`);
    try {
      const provider = new AntigravityProvider({ command: fake.command, model: 'Gemini 3.8 Flash (Low)' });
      await assert.rejects(
        provider.chat([{ role: 'user', content: 'ping' }]),
        /Antigravity returned no response/
      );
    } finally {
      fs.rmSync(fake.dir, { recursive: true, force: true });
    }
  });

  test('agy error result is rejected even when the process exits successfully', { skip: process.platform === 'win32' }, async () => {
    const fake = fakeAgy(`#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ event: 'result', result: { status: 'ERROR', response: 'Hello!', error: 'invalid prompt input' } }) + '\\n');
});
`);
    try {
      const provider = new AntigravityProvider({ command: fake.command, model: 'Gemini 3.8 Flash (Low)' });
      await assert.rejects(provider.chat([{ role: 'user', content: 'build a game' }]), /invalid prompt input/);
    } finally {
      fs.rmSync(fake.dir, { recursive: true, force: true });
    }
  });

  test('native agy file actions are surfaced in the response', { skip: process.platform === 'win32' }, async () => {
    const fake = fakeAgy(`#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
  emit({ event: 'step_update', step_update: { step_type: 'tool', state: 'ACTIVE', tool_name: 'write_file', tool_info: { name: 'write_file', parameters: { Path: 'cake.html' } } } });
  emit({ event: 'step_update', step_update: { step_type: 'tool', state: 'DONE', tool_name: 'write_file', tool_info: { name: 'write_file', parameters: { Path: 'cake.html' } } } });
  emit({ event: 'result', result: { status: 'SUCCESS', response: 'created cake.html', usage: { input_tokens: 10, output_tokens: 3 } } });
});
`);
    try {
      const provider = new AntigravityProvider({ command: fake.command, model: 'Gemini 3.8 Flash (Low)' });
      const seen = [];
      const response = await provider.chat([{ role: 'user', content: 'build a cake' }], {
        onNativeAction: (action) => seen.push(action)
      });
      assert.equal(response.content, 'created cake.html');
      assert.deepEqual(response.externalActions, [
        { name: 'write_file', status: 'completed', detail: 'cake.html' }
      ]);
      assert.deepEqual(seen.map((action) => action.status), ['running', 'completed']);
    } finally {
      fs.rmSync(fake.dir, { recursive: true, force: true });
    }
  });

  test('agy print-mode RunCommand denial routes through the Causyne tool gate', { skip: process.platform === 'win32' }, async () => {
    const fake = fakeAgy(`#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
  const update = (state) => emit({ event: 'step_update', step_update: {
    step_type: 'tool', state, tool_name: 'run_command',
    tool_info: { name: 'run_command', parameters: { CommandLine: 'pwd' } }
  } });
  update('ACTIVE');
  update('DONE');
  emit({ event: 'result', result: { status: 'SUCCESS', response: '',
    denied_actions: [{ action: 'run_command', display_name: 'RunCommand' }] } });
});
`);
    try {
      const provider = new AntigravityProvider({ command: fake.command });
      const seen = [];
      const response = await provider.chat([{ role: 'user', content: 'run pwd' }], {
        onNativeAction: (action) => seen.push(action.status)
      });
      assert.equal(response.content, '');
      assert.equal(response.toolCalls?.length, 1);
      assert.equal(response.toolCalls?.[0]?.function.name, 'sysRun');
      assert.deepEqual(JSON.parse(response.toolCalls?.[0]?.function.arguments), { command: 'pwd' });
      assert.deepEqual(response.externalActions, [
        { name: 'run_command', status: 'failed', detail: 'pwd' }
      ]);
      assert.deepEqual(seen, ['running', 'failed']);
    } finally {
      fs.rmSync(fake.dir, { recursive: true, force: true });
    }
  });

  test('a denied native action with no response is a failure, not a completed turn', { skip: process.platform === 'win32' }, async () => {
    const fake = fakeAgy(`#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    event: 'result',
    result: {
      status: 'SUCCESS',
      response: '',
      denied_actions: [{ action: 'write_file', display_name: 'WriteFile' }]
    }
  }) + '\\n');
});
`);
    try {
      const provider = new AntigravityProvider({ command: fake.command, model: 'Gemini 3.8 Flash (Low)' });
      await assert.rejects(
        provider.chat([{ role: 'user', content: 'build a cake' }]),
        (error) => error.code === 'AGY_NATIVE_ACTION_DENIED'
          && /Antigravity could not perform: WriteFile/.test(error.message)
      );
    } finally {
      fs.rmSync(fake.dir, { recursive: true, force: true });
    }
  });

  test('blocked native run_command is converted into a Causyne sysRun toolCall', { skip: process.platform === 'win32' }, async () => {
    const fake = fakeAgy(`#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
  emit({ event: 'step_update', step_update: { step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls -la . | grep -i savanna' } } } });
  emit({ event: 'step_update', step_update: { step_type: 'tool', state: 'ERROR', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls -la . | grep -i savanna' }, error: { message: 'permission check failed' } } } });
  emit({ event: 'result', result: { status: 'SUCCESS', response: '', denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } });
});
`);
    try {
      const provider = new AntigravityProvider({ command: fake.command, model: 'Gemini 3.8 Flash (Low)' });
      const response = await provider.chat([{ role: 'user', content: 'build a savanna game' }]);
      assert.ok(response.toolCalls && response.toolCalls.length === 1);
      assert.equal(response.toolCalls[0].function.name, 'sysRun');
      const args = JSON.parse(response.toolCalls[0].function.arguments);
      assert.equal(args.command, 'ls -la . | grep -i savanna');
    } finally {
      fs.rmSync(fake.dir, { recursive: true, force: true });
    }
  });

  test('_isTransientError identifies connection resets and stream timeouts', () => {
    const provider = new AntigravityProvider();
    assert.strictEqual(provider._isTransientError('read tcp: connection reset by peer'), true);
    assert.strictEqual(provider._isTransientError('ECONNRESET: socket closed'), true);
    assert.strictEqual(provider._isTransientError('streamGenerateContent failed'), true);
    assert.strictEqual(provider._isTransientError('status 503 Service Unavailable'), true);
    assert.strictEqual(provider._isTransientError('status 429 Too Many Requests'), true);
    assert.strictEqual(provider._isTransientError('Invalid API Key provided'), false);
    assert.strictEqual(provider._isTransientError(''), false);
    assert.strictEqual(provider._isTransientError(null), false);
  });

  test('formatConversation includes Action Directive and Language Directive', () => {
    const provider = new AntigravityProvider();
    const formatted = provider.formatConversation([{ role: 'user', content: 'test' }]);
    assert.ok(formatted.includes('[Action Directive]'));
    assert.ok(formatted.includes('NEVER reply with conversational pleasantries'));
    assert.ok(formatted.includes('[Language & Communication Directive]'));
  });

  test('extractToolCalls recovers unclosed tool_call JSON from large/partial responses', () => {
    const provider = new AntigravityProvider();
    const partial = 'I will create the game now.\n<tool_call>{"name": "fs_write", "arguments": {"path": "game.js", "content": "console.log(123);"';
    const calls = provider.extractToolCalls(partial);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].function.name, 'fs_write');
    assert.ok(calls[0].function.arguments.includes('game.js'));
  });

  test('mapNativeToolToCausyne maps openbrowserurl to desktop.open', async () => {
    const { mapNativeToolToCausyne } = await import('../src/providers/antigravity.js');
    const mapped = mapNativeToolToCausyne('openbrowserurl', { Url: 'http://localhost:8080' }, 0);
    assert.ok(mapped);
    assert.strictEqual(mapped.function.name, 'desktop.open');
    assert.deepStrictEqual(JSON.parse(mapped.function.arguments), { target: 'http://localhost:8080' });
  });

  test('multi-turn calls reuse conversation_id with --conversation', { skip: process.platform === 'win32' }, async () => {
    const argsLogFile = path.join(os.tmpdir(), `causyne-agy-multiturn-${process.pid}.json`);
    process.env.AGY_MULTITURN_LOG = argsLogFile;
    const fake = fakeAgy(`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
let currentLogs = [];
if (fs.existsSync(process.env.AGY_MULTITURN_LOG)) {
  try { currentLogs = JSON.parse(fs.readFileSync(process.env.AGY_MULTITURN_LOG, 'utf8')); } catch {}
}
currentLogs.push(args);
fs.writeFileSync(process.env.AGY_MULTITURN_LOG, JSON.stringify(currentLogs));

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const emit = ev => process.stdout.write(JSON.stringify(ev) + '\\n');
  emit({ event: 'init', conversation_id: 'conv-mock-123' });
  emit({ event: 'result', result: { status: 'SUCCESS', conversation_id: 'conv-mock-123', response: 'ok', usage: { input_tokens: 1, output_tokens: 1 } } });
});
`);
    try {
      const provider = new AntigravityProvider({ command: fake.command, model: 'Gemini 3.8 Flash (Low)' });
      // Turn 1
      await provider.chat([{ role: 'user', content: 'Turn 1' }], { taskId: 'task-abc' });
      assert.strictEqual(provider.currentConversationId, 'conv-mock-123');

      // Turn 2
      await provider.chat([
        { role: 'user', content: 'Turn 1' },
        { role: 'assistant', content: 'ok' },
        { role: 'tool', name: 'sysRun', content: 'output' }
      ], { taskId: 'task-abc' });

      const logs = JSON.parse(fs.readFileSync(argsLogFile, 'utf8'));
      assert.strictEqual(logs.length, 2);
      // Turn 1 should NOT have --conversation
      assert.strictEqual(logs[0].includes('--conversation'), false);
      // Turn 2 MUST have --conversation conv-mock-123
      assert.strictEqual(logs[1].includes('--conversation'), true);
      assert.strictEqual(logs[1][logs[1].indexOf('--conversation') + 1], 'conv-mock-123');
    } finally {
      delete process.env.AGY_MULTITURN_LOG;
      fs.rmSync(fake.dir, { recursive: true, force: true });
      fs.rmSync(argsLogFile, { force: true });
    }
  });
});

describe('isActionableTaskPrompt', () => {
  test('correctly distinguishes actionable tasks from casual greetings', async () => {
    const { isActionableTaskPrompt } = await import('../src/agentLoop.js');
    assert.strictEqual(isActionableTaskPrompt('create a 3js game shoting and optimized it with numpy'), true);
    assert.strictEqual(isActionableTaskPrompt('build a fullstack react dashboard with authentication'), true);
    assert.strictEqual(isActionableTaskPrompt('fix the bug in login controller'), true);
    assert.strictEqual(isActionableTaskPrompt('optimize sql query performance'), true);
    assert.strictEqual(isActionableTaskPrompt('open it i want to play'), true);
    assert.strictEqual(isActionableTaskPrompt('launch the game in browser'), true);
    assert.strictEqual(isActionableTaskPrompt('start the local dev server'), true);

    assert.strictEqual(isActionableTaskPrompt('hi'), false);
    assert.strictEqual(isActionableTaskPrompt('hello!'), false);
    assert.strictEqual(isActionableTaskPrompt('halo'), false);
    assert.strictEqual(isActionableTaskPrompt('good morning'), false);
    assert.strictEqual(isActionableTaskPrompt('selamat pagi'), false);
    assert.strictEqual(isActionableTaskPrompt(''), false);
  });

  test('correctly distinguishes execution/launch tasks from code authoring tasks', async () => {
    const { isExecutionOrLaunchTaskPrompt, isCodeAuthoringTaskPrompt } = await import('../src/agentLoop.js');

    assert.strictEqual(isExecutionOrLaunchTaskPrompt('open it i want to play'), true);
    assert.strictEqual(isExecutionOrLaunchTaskPrompt('open the 3js game i want to play'), true);
    assert.strictEqual(isExecutionOrLaunchTaskPrompt('launch the game in browser'), true);
    assert.strictEqual(isExecutionOrLaunchTaskPrompt('start the local dev server'), true);
    assert.strictEqual(isExecutionOrLaunchTaskPrompt('play the savanna hunter game'), true);

    assert.strictEqual(isCodeAuthoringTaskPrompt('open it i want to play'), false);
    assert.strictEqual(isCodeAuthoringTaskPrompt('open the 3js game i want to play'), false);
    assert.strictEqual(isCodeAuthoringTaskPrompt('launch the game in browser'), false);

    assert.strictEqual(isCodeAuthoringTaskPrompt('create a 3js game shoting and optimized it with numpy'), true);
    assert.strictEqual(isCodeAuthoringTaskPrompt('build a fullstack react dashboard with authentication'), true);
    assert.strictEqual(isCodeAuthoringTaskPrompt('write the server.py implementation'), true);
  });
});

describe('mapNativeToolToCausyne advanced mappings', () => {
  test('maps run_command with IsDaemon: true to sysRunBg', async () => {
    const { mapNativeToolToCausyne } = await import('../src/providers/antigravity.js');
    const mapped = mapNativeToolToCausyne('run_command', { CommandLine: 'python3 server.py 8081', IsDaemon: true }, 0);
    assert.ok(mapped);
    assert.strictEqual(mapped.function.name, 'sysRunBg');
    const args = JSON.parse(mapped.function.arguments);
    assert.strictEqual(args.command, 'python3 server.py 8081');
    assert.strictEqual(args.label, 'daemon');
  });

  test('maps multi_replace_file_content to MultiEdit', async () => {
    const { mapNativeToolToCausyne } = await import('../src/providers/antigravity.js');
    const mapped = mapNativeToolToCausyne('multi_replace_file_content', {
      TargetFile: '/path/to/game.js',
      ReplacementChunks: [
        { TargetContent: 'const speed = 1;', ReplacementContent: 'const speed = 5;' }
      ]
    }, 0);
    assert.ok(mapped);
    assert.strictEqual(mapped.function.name, 'MultiEdit');
    const args = JSON.parse(mapped.function.arguments);
    assert.strictEqual(args.file_path, '/path/to/game.js');
    assert.deepStrictEqual(args.edits, [{ old_string: 'const speed = 1;', new_string: 'const speed = 5;' }]);
  });

  test('maps browser_subagent with URL to desktop.open', async () => {
    const { mapNativeToolToCausyne } = await import('../src/providers/antigravity.js');
    const mapped = mapNativeToolToCausyne('browser_subagent', {
      Task: 'Navigate to http://localhost:8081/ and verify the 3D scene'
    }, 0);
    assert.ok(mapped);
    assert.strictEqual(mapped.function.name, 'desktop.open');
    assert.deepStrictEqual(JSON.parse(mapped.function.arguments), { target: 'http://localhost:8081/' });
  });

  test('maps manage_task list and kill to process_list and proc_term', async () => {
    const { mapNativeToolToCausyne } = await import('../src/providers/antigravity.js');
    const listMapped = mapNativeToolToCausyne('manage_task', { Action: 'list' }, 0);
    assert.ok(listMapped);
    assert.strictEqual(listMapped.function.name, 'process_list');

    const killMapped = mapNativeToolToCausyne('manage_task', { Action: 'kill', TaskId: 1234 }, 0);
    assert.ok(killMapped);
    assert.strictEqual(killMapped.function.name, 'proc_term');
    assert.deepStrictEqual(JSON.parse(killMapped.function.arguments), { pid: 1234 });
  });
});



