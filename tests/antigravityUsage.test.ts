import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AntigravityProvider } from '../src/providers/antigravity.js';

test('Antigravity cumulative session usage is charged to each turn only once', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-agy-usage-'));
  const command = path.join(directory, 'agy');
  fs.writeFileSync(command, `#!/usr/bin/env node
const resumed = process.argv.includes('--conversation');
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  emit({ event: 'init', conversation_id: 'usage-conversation' });
  emit({ event: 'result', result: {
    status: 'SUCCESS', conversation_id: 'usage-conversation', response: 'Done.',
    usage: resumed
      ? { input_tokens: 120, output_tokens: 27, thinking_tokens: 7, cache_read_tokens: 34 }
      : { input_tokens: 100, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 30 }
  } });
});
`, { mode: 0o755 });

  try {
    const provider = new AntigravityProvider({ command });
    const first = await provider.chat([{ role: 'user', content: 'Do task' }], { conversationId: 'session-1' });
    const second = await provider.chat([
      { role: 'user', content: 'Do task' },
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: 'Continue' }
    ], { conversationId: 'session-1' });
    assert.deepEqual(
      [first.usage.promptTokens, first.usage.completionTokens, first.usage.cachedPromptTokens, first.usage.thinkingTokens],
      [100, 20, 30, 5]
    );
    assert.deepEqual(
      [second.usage.promptTokens, second.usage.completionTokens, second.usage.cachedPromptTokens, second.usage.thinkingTokens],
      [20, 7, 4, 2]
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a desktop task stops after its native action budget', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-agy-budget-'));
  const command = path.join(directory, 'agy');
  fs.writeFileSync(command, `#!/usr/bin/env node
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  emit({ event: 'init', conversation_id: 'budget-conversation' });
  for (let index = 0; index < 13; index++) {
    emit({ event: 'step_update', step_update: {
      step_index: index, step_type: 'tool', state: 'ACTIVE',
      tool_name: 'search_web', tool_info: { name: 'search_web', parameters: { query: String(index) } }
    } });
  }
});
`, { mode: 0o755 });

  try {
    const provider = new AntigravityProvider({ command });
    await assert.rejects(
      provider.chat([{ role: 'user', content: 'Change my wallpaper' }], {
        conversationId: 'session-2', taskArchetype: 'desktop_personalization'
      }),
      (error: unknown) => (error as { code?: string }).code === 'AGY_NATIVE_ACTION_BUDGET'
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a non-success terminal status cannot be treated as a completed turn', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-agy-status-'));
  const command = path.join(directory, 'agy');
  fs.writeFileSync(command, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ event: 'result', result: {
    status: 'WAITING', response: 'Done.', conversation_id: 'waiting-conversation'
  } }) + '\\n');
});
`, { mode: 0o755 });
  try {
    const provider = new AntigravityProvider({ command });
    await assert.rejects(
      provider.chat([{ role: 'user', content: 'Change my wallpaper' }], { conversationId: 'session-3' }),
      /terminal status WAITING/
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
