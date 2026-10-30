import test from 'node:test';
import assert from 'node:assert/strict';
import { outcomeFromResult } from '../src/observer/evidence.js';

test('render evidence requires observed output, not a requested action or saved file', () => {
  for (const [tool, args, result] of [
    ['screenshot', {}, { success: true, output: 'Saved image.png' }],
    ['browser_act', { action: 'snapshot' }, { success: true }],
    ['browser_act', {}, { success: true, data: [{ action: 'preview' }] }],
    ['browser_act', {}, { success: true, data: [{ action: 'snapshot', data: {} }] }],
    ['browser_act', {}, { success: true, data: [{ action: 'snapshot', data: { runtimeErrors: ['Script failed'] } }] }]
  ] as const) {
    assert.notEqual(outcomeFromResult(tool, args, result).rendered, true);
  }
  assert.equal(outcomeFromResult('browser_act', {}, {
    success: true, data: [{ action: 'snapshot', data: { runtimeErrors: [] } }]
  }).rendered, true);
  assert.equal(outcomeFromResult('vision_inspect_ui', {}, {
    success: true, _is_image_marker: true
  }).rendered, true);
});
