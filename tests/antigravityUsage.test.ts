import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AntigravityProvider, isReadOnlyNativeInspection } from '../src/providers/antigravity.js';

test('native inspection classifier distinguishes Blender probes from scene writes', () => {
  assert.equal(isReadOnlyNativeInspection('RunCommand', { CommandLine: 'blender --background apple.blend --python-expr "print(bpy.context.scene.world)"' }), true);
  assert.equal(isReadOnlyNativeInspection('RunCommand', { CommandLine: '/Applications/Blender.app/Contents/MacOS/Blender --background apple.blend --python-expr "import bpy\nprint(bpy.context.scene.world)"' }), true);
  assert.equal(isReadOnlyNativeInspection('RunCommand', { CommandLine: 'blender --background apple.blend --python-expr "bpy.ops.wm.save_as_mainfile(filepath=\'apple.blend\')"' }), false);
  assert.equal(isReadOnlyNativeInspection('RunCommand', { CommandLine: 'grep -n world apple.py' }), true);
  assert.equal(isReadOnlyNativeInspection('RunCommand', { CommandLine: 'ls apple && python mutate.py' }), false);
  assert.equal(isReadOnlyNativeInspection('write_file', { path: 'apple.py' }), false);
});

test('Antigravity interrupts repeated Blender probes before the token ceiling and preserves the session', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-agy-inspection-'));
  const command = path.join(directory, 'agy');
  fs.writeFileSync(command, `#!/usr/bin/env node
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  emit({event:'init',conversation_id:'inspect-session'});
  emit({event:'step_update',step_update:{step_index:0,state:'DONE',step_type:'agent_response',usage:{input_tokens:300,output_tokens:30,cache_read_tokens:100}}});
  for (let index=1; index<=10; index++) emit({event:'step_update',step_update:{step_index:index,state:'ACTIVE',step_type:'tool',tool_name:'RunCommand',tool_info:{name:'RunCommand',parameters:{CommandLine:'grep -n world apple.py'}}}});
  setTimeout(() => {}, 10000);
});
`, { mode: 0o755 });
  try {
    const provider = new AntigravityProvider({ command });
    await assert.rejects(provider.chat([{ role: 'user', content: 'Fix the background in Blender' }], {
      conversationId: 'inspection-test', taskArchetype: 'media_3d_generation'
    }), (error: unknown) => {
      const stopped = error as { code?: string; inspectionCount?: number; partialUsage?: { promptTokens: number } };
      assert.equal(stopped.code, 'AGY_EXPLORATION_LOOP');
      assert.equal(stopped.inspectionCount, 10);
      assert.equal(stopped.partialUsage?.promptTokens, 300);
      return true;
    });
    assert.equal(provider.currentConversationId, 'inspect-session');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

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

test('Antigravity honors a large user task budget without clamping to 100k', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-agy-large-budget-'));
  const command = path.join(directory, 'agy');
  fs.writeFileSync(command, `#!/usr/bin/env node
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  emit({event:'init',conversation_id:'large-budget-test'});
  // Emit 150k tokens, which would have tripped the old 100k clamp
  emit({event:'step_update',step_update:{step_index:1,state:'DONE',step_type:'agent_response',usage:{input_tokens:150000,output_tokens:200,cache_read_tokens:50000}}});
  emit({event:'result',result:{status:'SUCCESS',response:'Completed large task successfully',usage:{input_tokens:150000,output_tokens:200}}});
});
`, { mode: 0o755 });
  try {
    const provider = new AntigravityProvider({ command });
    // User configured a 500,000 token budget
    const res = await provider.chat([{ role: 'user', content: 'Analyze large monorepo' }], { maxTokensThisCall: 500000 });
    assert.equal(res.content, 'Completed large task successfully');
    assert.equal(res.usage.promptTokens, 150000);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Antigravity does not abort multi-step turns when tokenLimit is Infinity', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-agy-infinity-'));
  const command = path.join(directory, 'agy');
  fs.writeFileSync(command, `#!/usr/bin/env node
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  emit({event:'init',conversation_id:'infinity-test'});
  // Emit 120k cumulative tokens in step update
  emit({event:'step_update',step_update:{step_index:1,state:'DONE',step_type:'agent_response',usage:{input_tokens:120000,output_tokens:500,cache_read_tokens:40000}}});
  emit({event:'result',result:{status:'SUCCESS',response:'Completed deep search without budget kill',usage:{input_tokens:120000,output_tokens:500}}});
});
`, { mode: 0o755 });
  try {
    const provider = new AntigravityProvider({ command });
    const res = await provider.chat([{ role: 'user', content: 'Deep research' }], { tokenLimit: Infinity });
    assert.equal(res.content, 'Completed deep search without budget kill');
    assert.equal(res.usage.promptTokens, 120000);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
