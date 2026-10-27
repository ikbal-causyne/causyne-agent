import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyProgressiveCompaction,
  measureMessages,
  decayToolResults
} from '../src/contextManager.js';

test('hlceCompaction: ephemeral decay prunes stale tool outputs while preserving recent steps', () => {
  const messages = [
    { role: 'user', content: 'buatkan aku 3d di blender simple 3d aplle red apple' },
    {
      role: 'tool',
      name: 'sysRun',
      content: 'Blender 4.2.0 Initialization:\n' + 'Vertex coordinates and metal shaders... '.repeat(100) // ~4,000 chars
    },
    {
      role: 'tool',
      name: 'sysRun',
      content: 'Blender Python Execution:\n' + 'BSDF Inputs node tree print... '.repeat(100) // ~3,000 chars
    },
    {
      role: 'tool',
      name: 'blender_act',
      content: 'Blender Render Step:\n' + 'Fra:1 Mem:48.2M Rendered image... '.repeat(100) // ~3,300 chars
    },
    {
      role: 'tool',
      name: 'fs_write',
      content: 'Successfully wrote create_apple.py (346 lines)' // Short recent output (< 100 chars)
    },
    {
      role: 'assistant',
      content: 'Created red_apple.blend and rendered preview.'
    }
  ];

  const initialChars = measureMessages(messages);
  assert.ok(initialChars > 10000, `Initial chars should be > 10,000, got ${initialChars}`);

  // Apply compaction with enableEphemeralDecay: keepRecent: 2, minChars: 1000
  const compaction = applyProgressiveCompaction(messages, 200000, {
    enableEphemeralDecay: true,
    ephemeralKeepRecent: 2,
    ephemeralMinChars: 1000
  });

  assert.ok(compaction.totalReclaimed > 0, 'Compaction must reclaim characters from stale tool outputs');
  assert.ok(compaction.stagesFired.some(s => s.startsWith('ephemeral_decay')), 'Must record ephemeral_decay stage');

  const finalChars = measureMessages(messages);
  assert.ok(finalChars < initialChars, 'Final character count must be smaller than initial count');

  // Verify that the oldest tool message (messages[1]) decayed into a concise receipt
  const oldestTool = messages[1];
  assert.ok(typeof oldestTool.content === 'string');
  assert.ok(oldestTool.content.includes('[decayed]'), 'Oldest tool output must contain [decayed] marker');
  assert.ok(oldestTool.content.length < 300, 'Oldest tool output must be reduced to < 300 characters');

  // Verify that the most recent tool message (messages[4]) was NOT decayed
  const recentTool = messages[4];
  assert.equal(recentTool.content, 'Successfully wrote create_apple.py (346 lines)');
});

test('hlceCompaction: decayToolResults respects keepRecent count', () => {
  const messages = [];
  for (let i = 0; i < 6; i++) {
    messages.push({
      role: 'tool',
      name: 'terminal',
      content: `Command ${i} output: ` + 'A'.repeat(2000)
    });
  }

  // keepRecent: 3 -> only the last 3 messages should be preserved untouched
  const reclaimed = decayToolResults(messages, { keepRecent: 3, minChars: 500 });
  assert.ok(reclaimed > 0);

  // Messages 0, 1, 2 should be decayed
  assert.ok(messages[0].content.includes('[decayed]'));
  assert.ok(messages[1].content.includes('[decayed]'));
  assert.ok(messages[2].content.includes('[decayed]'));

  // Messages 3, 4, 5 should remain untouched
  assert.ok(!messages[3].content.includes('[decayed]'));
  assert.ok(!messages[4].content.includes('[decayed]'));
  assert.ok(!messages[5].content.includes('[decayed]'));
});
