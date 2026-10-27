import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  StallGuardController,
  buildToolCallSignature,
  canonicalToolArgs,
  computeResultHash
} from '../src/stallGuard.js';

test('canonicalToolArgs sorts nested keys deterministically', () => {
  const obj1 = { z: 1, a: { b: 2, a: 1 } };
  const obj2 = { a: { a: 1, b: 2 }, z: 1 };
  assert.equal(canonicalToolArgs(obj1), canonicalToolArgs(obj2));
  assert.equal(
    buildToolCallSignature('testTool', obj1).argsHash,
    buildToolCallSignature('testTool', obj2).argsHash
  );
});

test('StallGuard warns at 3 identical consecutive calls with identical result', () => {
  const guard = new StallGuardController({ hardStopEnabled: true });
  const tool = 'fs_read';
  const args = { path: 'src/index.ts' };
  const result = 'export const foo = 42;\n';

  // Call 1
  const obs1 = guard.observeCall(tool, args, result, 'call_1');
  assert.equal(obs1.notice, null);
  assert.equal(obs1.stub, null);
  assert.equal(obs1.decision, null);

  // Call 2 (< 512 chars, no stub)
  const obs2 = guard.observeCall(tool, args, result, 'call_2');
  assert.equal(obs2.notice, null);
  assert.equal(obs2.stub, null);

  // Call 3: notice fires!
  const obs3 = guard.observeCall(tool, args, result, 'call_3');
  assert.ok(obs3.notice?.includes('consecutive identical call'));
  assert.ok(obs3.notice?.includes('fs_read'));
  assert.equal(guard.haltDecision, null);

  // Call 4
  const obs4 = guard.observeCall(tool, args, result, 'call_4');
  assert.ok(obs4.notice?.includes('consecutive identical call'));
  assert.equal(guard.haltDecision, null);

  // Call 5: halts
  const obs5 = guard.observeCall(tool, args, result, 'call_5');
  assert.ok(obs5.decision !== null);
  assert.equal(obs5.decision?.action, 'halt');
  assert.equal(guard.haltDecision?.action, 'halt');
});

test('StallGuard provides reference stub from 2nd identical call if result >= 512 chars', () => {
  const guard = new StallGuardController();
  const tool = 'fs_read';
  const args = { path: 'src/large.ts' };
  const largeResult = 'x'.repeat(600);

  const obs1 = guard.observeCall(tool, args, largeResult, 'call_1');
  assert.equal(obs1.stub, null);

  const obs2 = guard.observeCall(tool, args, largeResult, 'call_2');
  assert.ok(obs2.stub !== null);
  assert.ok(obs2.stub.includes('Duplicate result identical to prior call call_1'));
  assert.ok(obs2.stub.includes('src/large.ts'));
});

test('StallGuard repeatable pollers do not trigger identical call warning notice', () => {
  const guard = new StallGuardController();
  const tool = 'process_list';
  const args = {};
  const result = 'PID 123 node\n';

  for (let i = 0; i < 4; i++) {
    const obs = guard.observeCall(tool, args, result, `call_${i}`);
    assert.equal(obs.notice, null);
  }
  assert.equal(guard.haltDecision, null);
});

test('StallGuard detects multi-call repeating cycle of period 2 (A, B, A, B, A, B)', () => {
  const guard = new StallGuardController();
  const toolA = 'fs_read';
  const argsA = { path: 'a.txt' };
  const resA = 'content a';

  const toolB = 'grep_search';
  const argsB = { query: 'foo' };
  const resB = 'match in a.txt';

  // Lap 1: A, B
  guard.observeCall(toolA, argsA, resA, '1');
  guard.observeCall(toolB, argsB, resB, '2');

  // Lap 2: A, B
  guard.observeCall(toolA, argsA, resA, '3');
  guard.observeCall(toolB, argsB, resB, '4');

  // Lap 3: A, B
  guard.observeCall(toolA, argsA, resA, '5');
  const obsLast = guard.observeCall(toolB, argsB, resB, '6');

  assert.ok(obsLast.notice?.includes('repeated the same cycle of 2 tool calls'));
  assert.ok(obsLast.notice?.includes('grep_search'));
});

test('Successful mutation resets stall counters and inspection counts', () => {
  const guard = new StallGuardController();
  
  // Perform some read inspections
  for (let i = 0; i < 10; i++) {
    guard.observeCall('fs_read', { path: `file_${i}.txt` }, `content ${i}`, `id_${i}`);
  }
  assert.equal(guard.distinctInspectionCount, 10);

  // Perform a mutating call
  guard.observeCall('fs_write', { path: 'out.txt', content: 'done' }, { success: true }, 'id_write');
  assert.equal(guard.distinctInspectionCount, 0);
});

test('Deep research across 25 distinct files emits gentle progress notice without halting', () => {
  const guard = new StallGuardController({ researchNudgeAfter: 25 });

  for (let i = 1; i <= 24; i++) {
    const obs = guard.observeCall('fs_read', { path: `src/mod_${i}.ts` }, `content of ${i}`, `id_${i}`);
    assert.equal(obs.notice, null);
    assert.equal(guard.haltDecision, null);
  }

  // 25th distinct inspection emits gentle research notice
  const obs25 = guard.observeCall('fs_read', { path: 'src/mod_25.ts' }, 'content of 25', 'id_25');
  assert.ok(obs25.notice?.includes('RESEARCH PROGRESS NOTICE'));
  assert.ok(obs25.notice?.includes('25 consecutive inspection steps'));
  assert.equal(guard.haltDecision, null);

  // 26th inspection does not duplicate the nudge, nor does it halt
  const obs26 = guard.observeCall('fs_read', { path: 'src/mod_26.ts' }, 'content of 26', 'id_26');
  assert.equal(obs26.notice, null);
  assert.equal(guard.haltDecision, null);
});
