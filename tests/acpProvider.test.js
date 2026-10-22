import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AcpProvider, isAcpProvider } from '../src/providers/acp.js';
import { createProvider } from '../src/providers/factory.js';

describe('AcpProvider and isAcpProvider', () => {
  test('isAcpProvider recognizes acp prefixes and peer agent names', () => {
    assert.strictEqual(isAcpProvider('acp'), true);
    assert.strictEqual(isAcpProvider('acp/opencode'), true);
    assert.strictEqual(isAcpProvider('acp:codex'), true);
    assert.strictEqual(isAcpProvider('opencode'), true);
    assert.strictEqual(isAcpProvider('claude'), true);
    assert.strictEqual(isAcpProvider('codex'), true);
    assert.strictEqual(isAcpProvider('cursor'), true);
    assert.strictEqual(isAcpProvider('hermes'), true);
    assert.strictEqual(isAcpProvider('goose'), true);
    assert.strictEqual(isAcpProvider('copilot'), true);

    assert.strictEqual(isAcpProvider('openai'), false);
    assert.strictEqual(isAcpProvider('anthropic'), false);
    assert.strictEqual(isAcpProvider('gemini'), false);
    assert.strictEqual(isAcpProvider(''), false);
    assert.strictEqual(isAcpProvider(null), false);
    assert.strictEqual(isAcpProvider(undefined), false);
  });

  test('AcpProvider initializes with default opencode peer', () => {
    const provider = new AcpProvider({ provider: 'acp' });
    assert.strictEqual(provider.peerId, 'opencode');
    assert.ok(provider.command.includes('opencode'));
    assert.deepStrictEqual(provider.args, ['acp']);
  });

  test('AcpProvider resolves peer from provider prefix acp/claude', () => {
    const provider = new AcpProvider({ provider: 'acp/claude' });
    assert.strictEqual(provider.peerId, 'claude');
    assert.ok(provider.command === 'npx' || provider.command === 'claude');
    assert.ok(provider.args.some(a => a.includes('claude')));
  });

  test('AcpProvider resolves peer from model when specified', () => {
    const provider = new AcpProvider({ provider: 'acp', model: 'codex' });
    assert.strictEqual(provider.peerId, 'codex');
    assert.ok(provider.command === 'npx' || provider.command === 'codex');
    assert.ok(provider.args.some(a => a.includes('codex')));
  });

  test('createProvider instantiates AcpProvider when provider is acp or peer agent', () => {
    const p1 = createProvider({ provider: 'acp' });
    assert.ok(p1 instanceof AcpProvider);

    const p2 = createProvider({ provider: 'opencode' });
    assert.ok(p2 instanceof AcpProvider);

    const p3 = createProvider({ provider: 'acp/hermes' });
    assert.ok(p3 instanceof AcpProvider);
    assert.strictEqual(p3.peerId, 'hermes');
  });

  test('formatConversation formats roles cleanly and exposes tool instructions if tools provided', () => {
    const provider = new AcpProvider({ provider: 'acp' });
    const messages = [
      { role: 'system', content: 'You are a sovereign agent.' },
      { role: 'user', content: 'Hello there' },
      { role: 'assistant', content: 'Greetings! How can I assist you?' }
    ];

    const formatted = provider.formatConversation(messages, [{ name: 'sysRun' }]);
    assert.ok(formatted.includes('[Available Tools]'));
    assert.ok(formatted.includes('<tool_call>'));
    assert.ok(formatted.includes('[System Instructions]\nYou are a sovereign agent.'));
    assert.ok(formatted.includes('[User]\nHello there'));
    assert.ok(formatted.includes('[Assistant]\nGreetings! How can I assist you?'));
  });

  test('extractToolCalls parses XML tool_call blocks', () => {
    const provider = new AcpProvider({ provider: 'acp' });
    const sample = `I will run a command for you:
<tool_call>
{"name": "sysRun", "arguments": {"command": "echo sovereign"}}
</tool_call>
Done!`;

    const calls = provider.extractToolCalls(sample);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].function.name, 'sysRun');
    const parsedArgs = JSON.parse(calls[0].function.arguments);
    assert.strictEqual(parsedArgs.command, 'echo sovereign');
  });
});
