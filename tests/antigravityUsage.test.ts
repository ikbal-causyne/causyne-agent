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

test('a failed desktop turn preserves spent tokens and is not replayed', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-agy-partial-'));
  const command = path.join(directory, 'agy');
  const attempts = path.join(directory, 'attempts');
  fs.writeFileSync(command, `#!/usr/bin/env node
const fs = require('node:fs');
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(attempts)}, 'x');
  emit({event:'init',conversation_id:'partial-test'});
  emit({event:'step_update',step_update:{step_index:0,state:'DONE',step_type:'agent_response',usage:{input_tokens:90,output_tokens:10,cache_read_tokens:20}}});
  for (let index = 1; index <= 13; index++) emit({event:'step_update',step_update:{step_index:index,state:'ACTIVE',step_type:'tool',tool_name:'search_web'}});
});
`, { mode: 0o755 });
  try {
    const provider = new AntigravityProvider({ command });
    await assert.rejects(
      provider.chat([{ role: 'user', content: 'Change my wallpaper' }], {
        conversationId: 'session-partial', taskArchetype: 'desktop_personalization', maxRetries: 2
      }),
      (error: unknown) => {
        const failed = error as { code?: string; partialUsage?: { promptTokens: number; completionTokens: number; cachedPromptTokens?: number } };
        assert.equal(failed.code, 'AGY_NATIVE_ACTION_BUDGET');
        assert.equal(failed.partialUsage?.promptTokens, 90);
        assert.equal(failed.partialUsage?.completionTokens, 10);
        assert.equal(failed.partialUsage?.cachedPromptTokens, 20);
        return true;
      }
    );
    assert.equal(fs.readFileSync(attempts, 'utf8'), 'x');
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

test('Antigravity stops within a streamed turn when completed steps exhaust the remaining token budget', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-agy-token-cap-'));
  const command = path.join(directory, 'agy');
  fs.writeFileSync(command, `#!/usr/bin/env node
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  emit({event:'init',conversation_id:'budget-test'});
  emit({event:'step_update',step_update:{step_index:1,state:'ACTIVE',step_type:'agent_response'}});
  emit({event:'step_update',step_update:{step_index:1,state:'DONE',step_type:'agent_response',usage:{input_tokens:30,output_tokens:5,cache_read_tokens:20}}});
  emit({event:'step_update',step_update:{step_index:1,state:'DONE',step_type:'agent_response',usage:{input_tokens:30,output_tokens:5,cache_read_tokens:20}}});
  emit({event:'step_update',step_update:{step_index:2,state:'DONE',step_type:'checkpoint',usage:{input_tokens:16,output_tokens:2,cache_read_tokens:0}}});
  setTimeout(() => emit({event:'result',result:{status:'SUCCESS',response:'Should not finish',usage:{input_tokens:46,output_tokens:7}}}), 1000);
});
`, { mode: 0o755 });
  try {
    const provider = new AntigravityProvider({ command });
    await assert.rejects(
      provider.chat([{ role: 'user', content: 'Do task' }], { maxTokensThisCall: 40, maxRetries: 2 }),
      (error: unknown) => {
        const stopped = error as { code?: string; partialUsage?: { promptTokens: number; completionTokens: number; cachedPromptTokens?: number } };
        assert.equal(stopped.code, 'AGY_TOKEN_BUDGET');
        assert.deepEqual(stopped.partialUsage, {
          promptTokens: 46, completionTokens: 7, cachedPromptTokens: 20,
          thinkingTokens: 0, measurement: 'provider_reported', cacheMeasurement: 'provider_reported'
        });
        return true;
      }
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
