import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AntigravityProvider } from '../src/providers/antigravity.js';

/** A self-contained fake peer exercising the real stream-json parser. */
function fakeAgy(events: unknown[], waitMs = 0): { command: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-budget-completion-'));
  const command = path.join(dir, 'agy');
  const program = [
    '#!/usr/bin/env node',
    'const events=' + JSON.stringify(events) + ';',
    'process.stdin.resume();',
    'process.stdin.on("end", () => {',
    `  setTimeout(() => { for (const event of events) process.stdout.write(JSON.stringify(event)+"\\n"); }, ${waitMs});`,
    '});'
  ].join('\n');
  fs.writeFileSync(command, program, { mode: 0o755 });
  return { command, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function completedEvents(tokens = 35000): unknown[] {
  return [
    { event: 'init', conversation_id: 'budget-test-123' },
    { event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response',
      usage: { input_tokens: tokens, output_tokens: 250, cache_read_tokens: 0 } } },
    { event: 'result', result: { status: 'SUCCESS', conversation_id: 'budget-test-123',
      response: 'The requested work is complete.', usage: { input_tokens: tokens, output_tokens: 250 } } }
  ];
}

test('32k synthetic threshold no longer discards a successful >32k turn', { skip: process.platform === 'win32' }, async () => {
  const fake = fakeAgy(completedEvents(37000));
  try {
    const agent = new AntigravityProvider({ command: fake.command });
    const notices: unknown[] = [];
    const result = await agent.chat([{ role: 'user', content: 'Complete the task' }], {
      onBudgetAdvisory: (notice: unknown) => notices.push(notice)
    });
    assert.equal(result.content, 'The requested work is complete.');
    assert.equal(result.usage.promptTokens, 37000);
    assert.equal(notices.length, 1, 'soft notification must be emitted once per peer call');
  } finally { fake.cleanup(); }
});

test('explicit 20k per-call ceiling stops at streamed checkpoint', { skip: process.platform === 'win32' }, async () => {
  const fake = fakeAgy(completedEvents(37000));
  try {
    const agent = new AntigravityProvider({ command: fake.command });
    await assert.rejects(agent.chat([{ role: 'user', content: 'Work' }], { maxTokensThisCall: 20000 }), (err: any) => {
      assert.equal(err.code, 'AGY_TOKEN_BUDGET');
      assert.equal(err.tokenLimit, 20000);
      assert.equal(err.partialUsage?.promptTokens, 37000);
      return true;
    });
  } finally { fake.cleanup(); }
});

test('default desktop task has no invented 180s or 12-action ceiling', { skip: process.platform === 'win32' }, async () => {
  const actions = Array.from({length: 13}, (_, i) => [
    {event:'step_update',step_update:{step_index:i+1,state:'ACTIVE',step_type:'tool',tool_name:'run_command',
      tool_info:{name:'run_command',parameters:{CommandLine:`echo action_${i}`}}}},
    {event:'step_update',step_update:{step_index:i+1,state:'DONE',step_type:'tool',tool_name:'run_command',
      tool_info:{name:'run_command',parameters:{CommandLine:`echo action_${i}`}}}}
  ]).flat();
  const fake = fakeAgy([
    {event:'init',conversation_id:'desktop-test'}, ...actions,
    {event:'result',result:{ status:'SUCCESS',conversation_id:'desktop-test',response:'All actions recorded.',
      usage:{input_tokens:1000,output_tokens:100}}}
  ]);
  try {
    const agent = new AntigravityProvider({ command: fake.command });
    const result = await agent.chat([{ role: 'user', content: 'Desktop personalization' }], {
      taskArchetype: 'desktop_personalization'
    });
    assert.equal(result.content, 'All actions recorded.');
  } finally { fake.cleanup(); }
});

test('an explicitly configured desktop action ceiling still stops excess actions', { skip: process.platform === 'win32' }, async () => {
  const actions = Array.from({length: 13}, (_, i) => ({
    event: 'step_update', step_update: { step_index: i+1, state: 'ACTIVE', step_type: 'tool',
      tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: `echo action_${i}` } } }
  }));
  const fake = fakeAgy([
    {event:'init',conversation_id:'desktop-limit-test'}, ...actions,
    {event:'result',result:{status:'SUCCESS',response:'Should not finish'}}
  ]);
  try {
    const agent = new AntigravityProvider({ command: fake.command });
    await assert.rejects(agent.chat([{ role: 'user', content: 'Desktop' }], {
      taskArchetype: 'desktop_personalization', maxNativeActions: 12
    }), (err: any) => err.code === 'AGY_NATIVE_ACTION_BUDGET');
  } finally { fake.cleanup(); }
});
