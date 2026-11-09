import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureReadingAnchor, restoreReadingAnchor } from '../src/tui/viewportAnchor.js';
import { compactSuccessfulToolResult } from '../src/tui/toolActivityPolicy.js';

test('frame anchor survives wider/narrower paragraph wrapping', () => {
  const before = [{ id: 1, row: 0 }, { id: 2, row: 10 }, { id: 3, row: 30 }];
  const after = [{ id: 1, row: 0 }, { id: 2, row: 18 }, { id: 3, row: 66 }];
  const anchor = captureReadingAnchor(before, 20, 60);
  assert.equal(anchor?.id, 2);
  const restored = restoreReadingAnchor(anchor, after, 112, 12);
  assert.ok(restored >= 18 && restored < 66);
});

test('no markers and invalid values cannot introduce NaN or overflow', () => {
  assert.equal(captureReadingAnchor([{ id: 1, row: NaN }], 0, 20), null);
  const anchor = captureReadingAnchor([{ id: 1, row: 0 }], 99999, 100);
  assert.ok(anchor);
  const restored = restoreReadingAnchor(anchor, [{ id: 1, row: 0 }], 10, 60);
  assert.equal(restored, 0);
});

test('tool compaction accepts only silent success without unknown metadata', () => {
  const frame = { kind: 'step', meta: { step: 8, tool: 'run' } };
  assert.equal(compactSuccessfulToolResult(8, { success: true, elapsedMs: 40 }, frame, 'run'), true);
  assert.equal(compactSuccessfulToolResult(8, { success: true, output: 'diagnostics' }, frame, 'run'), false);
  assert.equal(compactSuccessfulToolResult(8, { success: false }, frame, 'run'), false);
  assert.equal(compactSuccessfulToolResult(8, { success: true, newProviderField: 9 }, frame, 'run'), false);
  assert.equal(compactSuccessfulToolResult(8, { success: true }, frame, 'write'), false);
});
