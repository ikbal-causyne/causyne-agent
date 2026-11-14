import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMessageActions } from '../src/tui/messageInteraction.js';

test('action card uses current reflowed marker row instead of stale pre-resize position', () => {
  let layer: any;
  const marker = { id: 7, kind: 'user', row: 999, meta: { messageText: 'A visible message' } } as any;
  const host = {
    busy: false, notice: '', scheduleDraw() {}, openLayer(next: unknown) { layer = next; },
    surface: {
      viewport: { width: 80, height: 5, scrollTop: 0 },
      transcript: { flatten: () => ({
        markers: [{ id: 7, row: 2, kind: 'user' }, { id: 8, row: 4, kind: 'assistant' }],
        rows: Array(7).fill('line')
      }) }
    }
  };
  openMessageActions(host as any, { memoryManager: { sessionId: 'nonexistent-test-session' } } as any, marker, 2);
  assert.deepEqual(layer.messageBounds, { startRow: 2, endRow: 3, textLength: 'A visible message'.length });
});
