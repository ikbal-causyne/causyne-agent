import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureReadingAnchor, restoreReadingAnchor } from '../src/tui/viewportAnchor.js';
import { compactSuccessfulToolResult, TOOL_ACTIVITY_COMPACT_AFTER } from '../src/tui/toolActivityPolicy.js';

const oldFrames = [
  { id: 5, row: 0 }, { id: 6, row: 10 }, { id: 7, row: 30 }, { id: 8, row: 90 }
];
const wrappedFrames = [
  { id: 5, row: 0 }, { id: 6, row: 16 }, { id: 7, row: 52 }, { id: 8, row: 122 }
];

test('width reflow anchors to the same frame, not the previous numeric scrollTop', () => {
  const anchor = captureReadingAnchor(oldFrames, 42, 130);
  assert.equal(anchor.id, 7);
  assert.equal(anchor.offset, 12);
  const position = restoreReadingAnchor(anchor, wrappedFrames, 175, 20);
  assert.ok(position >= 52 && position < 122);
  assert.notEqual(position, 42);
});

test('manual reading anchor preserves frame identity across height and width changes', () => {
  const anchor = captureReadingAnchor(oldFrames, 36, 130);
  const restored = restoreReadingAnchor(anchor, wrappedFrames, 175, 60);
  assert.ok(restored >= 52 && restored <= 115);
});

test('anchor is clamped when the transcript becomes shorter than the viewport', () => {
  const anchor = captureReadingAnchor(oldFrames, 92, 130);
  assert.equal(restoreReadingAnchor(anchor, wrappedFrames, 10, 40), 0);
});

test('evicted frame recovers at earliest surviving frame instead of old raw row', () => {
  const anchor = captureReadingAnchor(oldFrames, 11, 130);
  const position = restoreReadingAnchor(anchor, [{ id: 7, row: 0 }, { id: 8, row: 44 }], 120, 20);
  assert.equal(position, 2); // 5% of first surviving 44-row frame
});

test('unavailable markers use bounded numeric fallback', () => {
  const anchor = captureReadingAnchor(oldFrames, 125, 130);
  assert.equal(restoreReadingAnchor(anchor, [], 100, 20), 80);
});

test('eight consecutive successful silent tools collapse only from the threshold', () => {
  const tail = { kind: 'step', meta: { step: 8, tool: 'run' } };
  assert.equal(compactSuccessfulToolResult(7, { success: true }, tail, 'run'), false);
  assert.equal(compactSuccessfulToolResult(8, { success: true }, tail, 'run'), true);
  assert.equal(TOOL_ACTIVITY_COMPACT_AFTER, 8);
});

test('tool results with output or warnings remain expanded', () => {
  const tail = { kind: 'step', meta: { step: 14, tool: 'run' } };
  for (const result of [
    { success: false }, { success: true, output: 'success details' },
    { success: true, error: 'problem' }, { success: true, warnings: ['a warning'] },
    { success: true, spillPath: '/private/log' },
    { success: true, structuredContent: { summary: 'details' } }
  ]) assert.equal(compactSuccessfulToolResult(14, result, tail, 'run'), false);
  assert.equal(compactSuccessfulToolResult(14, { success: true }, tail, 'read'), false);
});

test('malformed frame-marker inputs never yield NaN or unbounded coordinates', () => {
  assert.equal(captureReadingAnchor([{ id: 1, row: NaN }], 10, 40), null);
  assert.equal(restoreReadingAnchor({ id: 1, index: 0, offset: 1, fraction: NaN, originalTop: -10 }, [{ id: 1, row: 0 }], 100, 30), 0);
});
