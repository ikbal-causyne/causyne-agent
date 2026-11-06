import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveToolCallEnvelopeArguments } from '../src/implementationPlan.js';
import { selfRepairToolCall } from '../src/tools/toolSelfRepair.js';
import { validateToolArguments } from '../src/tools/argumentValidation.js';
import { updatePlan } from '../src/tools/updatePlan.js';
import { AcpClient } from '../src/acp/client.js';
import { AntigravityProvider } from '../src/providers/antigravity.js';

const planSchema = updatePlan.schema.parameters as any;

function repairPlan(args: unknown) {
  return selfRepairToolCall(
    { function: { name: 'update_plan', arguments: typeof args === 'string' ? args : JSON.stringify(args) } },
    planSchema
  );
}

test('flat tool-call envelopes keep their arguments instead of collapsing to {}', () => {
  const args = resolveToolCallEnvelopeArguments({ name: 'update_plan', plan: [{ step: 'Scaffold', status: 'pending' }] });
  assert.deepEqual(args, { plan: [{ step: 'Scaffold', status: 'pending' }] });
  assert.deepEqual(resolveToolCallEnvelopeArguments({ name: 'x', arguments: { a: 1 } }), { a: 1 });
  assert.deepEqual(resolveToolCallEnvelopeArguments({ function: { name: 'x', arguments: '{"a":1}' } }), '{"a":1}');
  assert.deepEqual(resolveToolCallEnvelopeArguments({ name: 'x' }), {});
});

test('antigravity extractToolCalls preserves flat update_plan and browser_act arguments', () => {
  const provider = Object.create(AntigravityProvider.prototype);
  const calls = provider.extractToolCalls(
    '<tool_call>{"name":"update_plan","plan":[{"id":"a","step":"Plan","status":"in_progress"}]}</tool_call>\n' +
    '<tool_call>{"name":"browser_act","actions":[{"type":"preview","filePath":"index.html"}]}</tool_call>'
  );
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[0].function.arguments).plan.length, 1);
  assert.equal(JSON.parse(calls[1].function.arguments).actions[0].type, 'preview');
});

test('update_plan accepts TodoWrite todos shape without a validation error', () => {
  const repaired = repairPlan({ todos: [
    { content: 'Inspect APK', status: 'completed', activeForm: 'Inspecting APK' },
    { content: 'Scaffold Kotlin app', status: 'in_progress', activeForm: 'Scaffolding' }
  ] });
  assert.deepEqual(validateToolArguments(repaired.args, planSchema), []);
  const plan = (repaired.args as any).plan;
  assert.equal(plan[0].step, 'Inspect APK');
  assert.equal(plan[1].status, 'in_progress');
  assert.equal(plan[0].activeForm, undefined);
});

test('update_plan accepts JSON-encoded, plain-text, and string-item plans', () => {
  const encoded = repairPlan({ plan: JSON.stringify([{ step: 'Build', status: 'pending' }]) });
  assert.deepEqual(validateToolArguments(encoded.args, planSchema), []);

  const text = repairPlan({ plan: '1. Plan\n2. Scaffold\n- [ ] Verify' });
  assert.deepEqual(validateToolArguments(text.args, planSchema), []);
  assert.deepEqual((text.args as any).plan.map((s: any) => s.step), ['Plan', 'Scaffold', 'Verify']);

  const strings = repairPlan({ steps: ['Plan', 'Implement'] });
  assert.deepEqual(validateToolArguments(strings.args, planSchema), []);
});

test('update_plan with no plan at all still reports a truthful validation error', () => {
  const repaired = repairPlan({});
  assert.deepEqual(validateToolArguments(repaired.args, planSchema), ['arguments.plan is required']);
});

test('ACP inactivity guard re-arms while a peer-native tool call is running', async () => {
  const client = new AcpClient({ command: 'opencode', cwd: process.cwd(), inactivityTimeoutMs: 40, promptTimeoutMs: 400 });
  const writes: any[] = [];
  (client as any).child = {
    stdin: { write: (line: string) => { writes.push(JSON.parse(line)); return true; }, destroy: () => {} },
    exitCode: null,
    signalCode: null
  };
  (client as any).write = (msg: unknown) => writes.push(msg);
  (client as any).trackToolCall('s1', { sessionUpdate: 'tool_call', toolCallId: 't1', status: 'in_progress' });

  const pending = (client as any).request('session/prompt', {}, 400, undefined, { sessionId: 's1', inactivityTimeoutMs: 40 });
  let settled: string | null = null;
  pending.then(() => { settled = 'resolved'; }, (e: Error) => { settled = e.message; });

  await new Promise(r => setTimeout(r, 130));
  assert.equal(settled, null, 'an open tool call must not be reported as a stall');

  (client as any).trackToolCall('s1', { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
  await new Promise(r => setTimeout(r, 90));
  assert.match(String(settled), /stalled: no activity from peer/);
});
