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

test('Antigravity allows a long sequence of distinct Blender inspections', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-agy-inspection-'));
  const command = path.join(directory, 'agy');
  fs.writeFileSync(command, `#!/usr/bin/env node
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  emit({event:'init',conversation_id:'inspect-session'});
  emit({event:'step_update',step_update:{step_index:0,state:'DONE',step_type:'agent_response',usage:{input_tokens:300,output_tokens:30,cache_read_tokens:100}}});
  for (let index=1; index<=30; index++) emit({event:'step_update',step_update:{step_index:index,state:'ACTIVE',step_type:'tool',tool_name:'RunCommand',tool_info:{name:'RunCommand',parameters:{CommandLine:'grep -n world scene-' + index + '.py'}}}});
  emit({event:'result',result:{status:'SUCCESS',conversation_id:'inspect-session',response:'Inspected all scene files.',usage:{input_tokens:300,output_tokens:30,cache_read_tokens:100}}});
});
`, { mode: 0o755 });
  try {
    const provider = new AntigravityProvider({ command });
    const response = await provider.chat([{ role: 'user', content: 'Inspect the background in Blender' }], {
      conversationId: 'inspection-test', taskArchetype: 'media_3d_generation'
    });
    assert.match(String(response.content), /Inspected all scene files/);
    assert.equal(provider.currentConversationId, 'inspect-session');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Antigravity checkpoints repeated reads of one Blender scene before another paid probe', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-agy-scene-loop-'));
  const command = path.join(directory, 'agy');
  fs.writeFileSync(command, `#!/usr/bin/env node
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  emit({event:'init',conversation_id:'scene-loop'});
  emit({event:'step_update',step_update:{step_index:0,state:'DONE',step_type:'agent_response',usage:{input_tokens:80,output_tokens:20,cache_read_tokens:40}}});
  for (let index=1; index<=9; index++) {
    emit({event:'step_update',step_update:{step_index:index,state:'ACTIVE',step_type:'tool',tool_name:'RunCommand',tool_info:{name:'RunCommand',parameters:{CommandLine:'blender --background "apple.blend1" --python-expr "print(' + index + ')"'}}}});
    if (index === 4) emit({event:'step_update',step_update:{step_index:20,state:'ACTIVE',step_type:'tool',tool_name:'RunCommand',tool_info:{name:'RunCommand',parameters:{CommandLine:'git status'}}}});
  }
  emit({event:'result',result:{status:'SUCCESS',conversation_id:'scene-loop',response:'Inspected only.',usage:{input_tokens:80,output_tokens:20}}});
});
`, { mode: 0o755 });
  try {
    const provider = new AntigravityProvider({ command });
    await assert.rejects(
      provider.chat([{ role: 'user', content: 'Fix the missing background in apple.blend' }], {
        conversationId: 'scene-loop-test', taskArchetype: 'media_3d_generation'
      }),
      (error: unknown) => {
        const checkpoint = error as { code?: string; inspectionCount?: number; partialUsage?: { promptTokens: number; completionTokens: number } };
        assert.equal(checkpoint.code, 'AGY_EXPLORATION_LOOP');
        assert.equal(checkpoint.inspectionCount, 8);
        assert.equal(checkpoint.partialUsage?.promptTokens, 80);
        assert.equal(checkpoint.partialUsage?.completionTokens, 20);
        return true;
      }
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a scene edit resets the repeated-inspection checkpoint', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-agy-scene-progress-'));
  const command = path.join(directory, 'agy');
  fs.writeFileSync(command, `#!/usr/bin/env node
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  emit({event:'init',conversation_id:'scene-progress'});
  for (let index=1; index<=7; index++) emit({event:'step_update',step_update:{step_index:index,state:'ACTIVE',step_type:'tool',tool_name:'RunCommand',tool_info:{name:'RunCommand',parameters:{CommandLine:'blender --background "apple.blend1" --python-expr "print(' + index + ')"'}}}});
  emit({event:'step_update',step_update:{step_index:8,state:'ACTIVE',step_type:'tool',tool_name:'write_file',tool_info:{name:'write_file',parameters:{path:'fix.py'}}}});
  emit({event:'step_update',step_update:{step_index:8,state:'DONE',step_type:'tool',tool_name:'write_file',tool_info:{name:'write_file',parameters:{path:'fix.py'}}}});
  for (let index=9; index<=15; index++) emit({event:'step_update',step_update:{step_index:index,state:'ACTIVE',step_type:'tool',tool_name:'RunCommand',tool_info:{name:'RunCommand',parameters:{CommandLine:'blender --background "apple.blend1" --python-expr "print(' + index + ')"'}}}});
  emit({event:'result',result:{status:'SUCCESS',conversation_id:'scene-progress',response:'Edited and verified.',usage:{input_tokens:200,output_tokens:40}}});
});
`, { mode: 0o755 });
  try {
    const provider = new AntigravityProvider({ command });
    const response = await provider.chat([{ role: 'user', content: 'Fix the missing background in apple.blend' }], {
      conversationId: 'scene-progress-test', taskArchetype: 'media_3d_generation'
    });
    assert.equal(response.content, 'Edited and verified.');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a failed scene edit does not reset the repeated-inspection checkpoint', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-agy-scene-failed-edit-'));
  const command = path.join(directory, 'agy');
  fs.writeFileSync(command, `#!/usr/bin/env node
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  emit({event:'init',conversation_id:'scene-failed-edit'});
  for (let index=1; index<=7; index++) emit({event:'step_update',step_update:{step_index:index,state:'ACTIVE',step_type:'tool',tool_name:'RunCommand',tool_info:{name:'RunCommand',parameters:{CommandLine:'blender --background "apple.blend1" --python-expr "print(' + index + ')"'}}}});
  emit({event:'step_update',step_update:{step_index:8,state:'ACTIVE',step_type:'tool',tool_name:'write_file',tool_info:{name:'write_file',parameters:{path:'fix.py'}}}});
  emit({event:'step_update',step_update:{step_index:8,state:'ERROR',step_type:'tool',tool_name:'write_file',tool_info:{name:'write_file',parameters:{path:'fix.py'},error:{message:'Permission denied'}}}});
  emit({event:'step_update',step_update:{step_index:9,state:'ACTIVE',step_type:'tool',tool_name:'RunCommand',tool_info:{name:'RunCommand',parameters:{CommandLine:'blender --background "apple.blend1" --python-expr "print(8)"'}}}});
  emit({event:'result',result:{status:'SUCCESS',conversation_id:'scene-failed-edit',response:'No change.'}});
});
`, { mode: 0o755 });
  try {
    const provider = new AntigravityProvider({ command });
    await assert.rejects(
      provider.chat([{ role: 'user', content: 'Fix the missing background in apple.blend' }], {
        conversationId: 'scene-failed-edit-test', taskArchetype: 'media_3d_generation'
      }),
      (error: unknown) => (error as { code?: string }).code === 'AGY_EXPLORATION_LOOP'
    );
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

test('Antigravity treats tokenLimit Infinity as unset and keeps a finite default ceiling', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-agy-infinity-'));
  const command = path.join(directory, 'agy');
  fs.writeFileSync(command, `#!/usr/bin/env node
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  emit({event:'init',conversation_id:'infinity-test'});
  // Emit 120k cumulative tokens in step update
  emit({event:'step_update',step_update:{step_index:1,state:'DONE',step_type:'agent_response',usage:{input_tokens:120000,output_tokens:500,cache_read_tokens:0}}});
  emit({event:'result',result:{status:'SUCCESS',response:'Completed deep search without budget kill',usage:{input_tokens:120000,output_tokens:500}}});
});
`, { mode: 0o755 });
  try {
    const provider = new AntigravityProvider({ command });
    await assert.rejects(
      provider.chat([{ role: 'user', content: 'Deep research' }], { tokenLimit: Infinity }),
      (error: unknown) => {
        const stopped = error as { code?: string; tokenLimit?: number; partialUsage?: { promptTokens?: number } };
        assert.equal(stopped.code, 'AGY_TOKEN_BUDGET');
        assert.equal(stopped.tokenLimit, 100_000);
        assert.equal(stopped.partialUsage?.promptTokens, 120000);
        return true;
      }
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Antigravity extracts Blender targets with escaped quotes and spaces in path for exploration checkpoints', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-agy-escaped-path-'));
  const command = path.join(directory, 'agy');
  fs.writeFileSync(command, `#!/usr/bin/env node
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  emit({event:'init',conversation_id:'escaped-path-loop'});
  for (let index = 1; index <= 9; index++) {
    emit({
      event: 'step_update',
      step_update: {
        step_index: index,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: {
          name: 'run_command',
          parameters: {
            CommandLine: '"/Applications/Blender.app/Contents/MacOS/Blender --background \\\\"/Users/developer/Causyne AI/causyne-agent/blender_apple/red_apple.blend\\\\" --python-expr \\\\"print(scene.render.engine)\\\\""'
          }
        }
      }
    });
  }
  emit({event:'result',result:{status:'SUCCESS',conversation_id:'escaped-path-loop',response:'Should not finish'}});
});
`, { mode: 0o755 });
  try {
    const provider = new AntigravityProvider({ command });
    await assert.rejects(
      provider.chat([{ role: 'user', content: 'Fix the background in .blend' }], {
        conversationId: 'escaped-path-test', taskArchetype: 'media_3d_generation'
      }),
      (error: unknown) => {
        const checkpoint = error as { code?: string; inspectionCount?: number };
        assert.equal(checkpoint.code, 'AGY_EXPLORATION_LOOP');
        assert.equal(checkpoint.inspectionCount, 8);
        return true;
      }
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Antigravity enforces the default 100k ceiling when tokenLimit is undefined', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-agy-default-100k-'));
  const command = path.join(directory, 'agy');
  fs.writeFileSync(command, `#!/usr/bin/env node
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  emit({event:'init',conversation_id:'default-cap-test'});
  emit({event:'step_update',step_update:{step_index:1,state:'DONE',step_type:'agent_response',usage:{input_tokens:99000,output_tokens:2000,cache_read_tokens:0}}});
  setTimeout(() => emit({event:'result',result:{status:'SUCCESS',response:'Should be stopped by default 100k ceiling'}}), 500);
});
`, { mode: 0o755 });
  try {
    const provider = new AntigravityProvider({ command });
    await assert.rejects(
      provider.chat([{ role: 'user', content: 'Normal prompt without task budget' }], { conversationId: 'session-default-cap' }),
      (error: unknown) => {
        const stopped = error as { code?: string; tokenLimit?: number };
        assert.equal(stopped.code, 'AGY_TOKEN_BUDGET');
        assert.equal(stopped.tokenLimit, 100_000);
        return true;
      }
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('separate peer cache counters never subtract already-fresh input', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-agy-cached-floor-'));
  const command = path.join(directory, 'agy');
  fs.writeFileSync(command, `#!/usr/bin/env node
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  emit({event:'init',conversation_id:'cached-floor-test'});
  emit({event:'step_update',step_update:{step_index:1,state:'DONE',step_type:'agent_response',usage:{input_tokens:99000,output_tokens:2000,cache_read_tokens:10000}}});
  emit({event:'result',result:{status:'SUCCESS',response:'Finished with cached input',usage:{input_tokens:99000,output_tokens:2000,cache_read_tokens:10000}}});
});
`, { mode: 0o755 });
  try {
    const provider = new AntigravityProvider({ command });
    await assert.rejects(provider.chat([{ role: 'user', content: 'Use cached context' }], {}), (error: unknown) => (error as { code: string }).code === 'AGY_TOKEN_BUDGET');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
