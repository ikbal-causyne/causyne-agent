import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AntigravityProvider, isAntigravityProvider, resolveAgyBinary, ANTIGRAVITY_MODELS } from '../src/providers/antigravity.js';
import { createProvider } from '../src/providers/factory.js';

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
  });
});
