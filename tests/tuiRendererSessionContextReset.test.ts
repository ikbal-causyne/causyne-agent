import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatRenderer } from '../src/tui/chatRenderer.js';
import { Transcript } from '../src/tui/transcript.js';

test('switching from a populated conversation to an empty session clears stale usage', () => {
  const transcript = new Transcript();
  const renderer = new ChatRenderer({ transcript, out: { columns: 120, write: () => true, isTTY: false } });
  renderer.renderSessionHistory([{ role: 'user', content: 'Previous conversation containing several words' }], { id: 'old', title: 'Old session' });
  assert.ok(renderer.status.contextChars > 0);
  renderer.renderSessionHistory([], { id: 'new', title: 'Fresh session' });
  assert.equal(renderer.status.contextChars, 0);
});
