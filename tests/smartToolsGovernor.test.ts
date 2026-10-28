import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SmartToolsGovernor } from '../src/smartToolsUse.ts';

test('third inspection suggests synthesis once but does not block evidence gathering', () => {
  const governor = new SmartToolsGovernor();
  assert.equal(governor.observe('fs_read', { path: 'a' }, { success: true }), null);
  assert.equal(governor.observe('fs_search', { query: 'b' }, { success: true }), null);
  const nudge = governor.observe('web_search', { query: 'c' }, { success: true });
  assert.match(nudge ?? '', /Continue inspecting if the task still needs evidence/);
  assert.equal(governor.snapshot().phase, 'synthesis');
  assert.equal(governor.observe('fs_read', { path: 'd' }, { success: true }), null);
  assert.equal(governor.snapshot().consecutiveInspections, 4);
});

test('mutation resets the inspection streak and verification requires explicit success', () => {
  const governor = new SmartToolsGovernor();
  governor.observe('fs_read', {}, { success: true });
  governor.observe('fs_read', {}, { success: true });
  governor.observe('fs_write', { path: 'a' }, { success: true });
  assert.deepEqual(governor.snapshot(), {
    phase: 'execution', consecutiveInspections: 0,
    mutationAttempted: true, verificationObserved: false
  });
  governor.observe('screenshot', {}, { output: 'unverified' });
  assert.equal(governor.snapshot().verificationObserved, false);
  governor.observe('screenshot', {}, { success: false });
  assert.equal(governor.snapshot().verificationObserved, false);
  governor.observe('screenshot', {}, { success: true });
  assert.equal(governor.snapshot().verificationObserved, true);
  governor.reset();
  assert.equal(governor.snapshot().phase, 'inspection');
});

test('tool discovery does not consume inspection budget', () => {
  const governor = new SmartToolsGovernor();
  governor.observe('tool_search', { query: 'browser' }, { success: true });
  assert.equal(governor.snapshot().consecutiveInspections, 0);
});
