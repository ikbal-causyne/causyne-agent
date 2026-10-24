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

  test('chat sends a stream-json user event and limits agy to workspace edits', { skip: process.platform === 'win32' }, async () => {
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
      assert.equal(args[args.indexOf('--mode') + 1], 'accept-edits');
      assert.ok(args.includes('--output-format'));
      assert.ok(!args.includes('--dangerously-skip-permissions'));
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
        /Antigravity could not perform: WriteFile/
      );
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
});

describe('isActionableTaskPrompt', () => {
  test('correctly distinguishes actionable tasks from casual greetings', async () => {
    const { isActionableTaskPrompt } = await import('../src/agentLoop.js');
    assert.strictEqual(isActionableTaskPrompt('create a 3js game shoting and optimized it with numpy'), true);
    assert.strictEqual(isActionableTaskPrompt('build a fullstack react dashboard with authentication'), true);
    assert.strictEqual(isActionableTaskPrompt('fix the bug in login controller'), true);
    assert.strictEqual(isActionableTaskPrompt('optimize sql query performance'), true);

    assert.strictEqual(isActionableTaskPrompt('hi'), false);
    assert.strictEqual(isActionableTaskPrompt('hello!'), false);
    assert.strictEqual(isActionableTaskPrompt('halo'), false);
    assert.strictEqual(isActionableTaskPrompt('good morning'), false);
    assert.strictEqual(isActionableTaskPrompt('selamat pagi'), false);
    assert.strictEqual(isActionableTaskPrompt(''), false);
  });
});

