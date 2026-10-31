import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodexStyleSummary,
  compactSessionMessages,
  autoCompactIfUnderPressure,
  runCompactSlashCommand
} from '../src/core/contextCompactor.js';

test('buildCodexStyleSummary generates structured state checkpoint with files and architecture', () => {
  const dropped = [
    {
      role: 'assistant',
      content: 'I will design the 3D human anatomy simulator using Three.js and Web Audio Engine.',
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: {
            name: 'fs_write',
            arguments: JSON.stringify({ path: 'human-anatomy-3d/app.js', content: '// canvas 3d app' })
          }
        },
        {
          id: 'call-2',
          type: 'function',
          function: {
            name: 'fs_write',
            arguments: JSON.stringify({ path: 'human-anatomy-3d/audio-engine.js', content: '// audio engine' })
          }
        }
      ]
    },
    {
      role: 'tool',
      name: 'fs_write',
      tool_call_id: 'call-1',
      content: JSON.stringify({ success: true, path: 'human-anatomy-3d/app.js' })
    },
    {
      role: 'tool',
      name: 'fs_write',
      tool_call_id: 'call-2',
      content: JSON.stringify({ success: true, path: 'human-anatomy-3d/audio-engine.js' })
    }
  ];

  const summary = buildCodexStyleSummary(dropped as any, 'Create interactive human anatomy 3D application');

  assert.ok(summary.includes('### [COMPACTED CONTEXT CHECKPOINT — CODEX STATE PRESERVATION]'));
  assert.ok(summary.includes('Create interactive human anatomy 3D application'));
  assert.ok(summary.includes('Three.js / WebGL 3D rendering pipeline'));
  assert.ok(summary.includes('Web Audio Engine & sound effects'));
  assert.ok(summary.includes('human-anatomy-3d/app.js'));
  assert.ok(summary.includes('human-anatomy-3d/audio-engine.js'));
  assert.ok(summary.includes('Directive for Continuation:'));
});

test('compactSessionMessages preserves root user anchor and recent turns while condensing history', () => {
  const messages: any[] = [
    { role: 'user', content: 'Build a detailed 3D city scene in Three.js' }, // Root Anchor (Index 0)
    { role: 'assistant', content: 'Inspecting workspace structure', tool_calls: [{ id: 'c1', function: { name: 'fs_list', arguments: '{}' } }] },
    { role: 'tool', name: 'fs_list', tool_call_id: 'c1', content: 'package.json, src/, public/, tests/, dist/, node_modules/ '.repeat(100) },
    { role: 'assistant', content: 'Creating scene manager', tool_calls: [{ id: 'c2', function: { name: 'fs_write', arguments: '{"path":"city.js"}' } }] },
    { role: 'tool', name: 'fs_write', tool_call_id: 'c2', content: JSON.stringify({ success: true, output: 'city scene code written '.repeat(150) }) },
    { role: 'assistant', content: 'Creating building generator', tool_calls: [{ id: 'c3', function: { name: 'fs_write', arguments: '{"path":"buildings.js"}' } }] },
    { role: 'tool', name: 'fs_write', tool_call_id: 'c3', content: JSON.stringify({ success: true, output: 'procedural building mesh generator '.repeat(150) }) },
    // Recent working window (last 4 turns)
    { role: 'assistant', content: 'Now implementing camera controls' },
    { role: 'user', content: 'Make sure lighting is realistic' },
    { role: 'assistant', content: 'Adding directional and ambient lighting' },
    { role: 'assistant', content: 'Drafting lighting setup' }
  ];

  const initialCount = messages.length;
  const result = compactSessionMessages(messages, { keepRecentTurns: 4 });

  assert.equal(result.compacted, true);
  assert.ok(result.removedCount > 0);
  assert.ok(result.reclaimedChars > 0);
  assert.ok(messages.length < initialCount);

  // Root message at index 0 must be preserved
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, 'Build a detailed 3D city scene in Three.js');

  // Compaction summary must be at index 1
  assert.equal(messages[1].role, 'user');
  assert.ok(messages[1].content.includes('[COMPACTED CONTEXT SUMMARY'));
  assert.ok(messages[1].content.includes('city.js'));

  // Last message must still be the active working turn
  assert.equal(messages[messages.length - 1].content, 'Drafting lighting setup');
});

test('runCompactSlashCommand provides human-readable diagnostic report', async () => {
  const mockLoop = {
    taskId: 'test-compact',
    userPrompt: 'Build 3D human anatomy',
    messages: [
      { role: 'user', content: 'Build 3D human anatomy' },
      { role: 'assistant', content: 'Step 1' },
      { role: 'tool', content: 'Result 1' },
      { role: 'assistant', content: 'Step 2' },
      { role: 'tool', content: 'Result 2' },
      { role: 'assistant', content: 'Step 3' },
      { role: 'assistant', content: 'Step 4' },
      { role: 'assistant', content: 'Step 5' }
    ],
    memoryManager: {
      saveHistory: (_msgs: any[]) => {}
    }
  };

  const res = await runCompactSlashCommand([], { loop: mockLoop });
  assert.equal(res.ok, true);
  assert.ok(res.output.includes('Context successfully compacted'));
  assert.ok(res.output.includes('Earlier messages condensed:'));
  assert.ok(res.output.includes('Golden Anchor (original prompt) & recent working turns: Preserved in full'));
});

test('autoCompactIfUnderPressure triggers when context crosses threshold and saves history', () => {
  let saved = false;
  let statusEmitted = '';

  const mockLoop = {
    taskId: 'pressure-task',
    userPrompt: 'Generate large codebase',
    _contextLimitChars: 1_000, // Small threshold for testing
    messages: [
      { role: 'user', content: 'Generate large codebase' },
      ...Array.from({ length: 15 }, (_, i) => ({
        role: i % 2 === 0 ? 'assistant' : 'tool',
        content: `Detailed intermediate step message number ${i} with extra padding chars to trigger threshold pressure`
      }))
    ],
    memoryManager: {
      saveHistory: (_msgs: any[]) => { saved = true; }
    },
    emitEvent: (ev: any) => {
      if (ev.type === 'status') statusEmitted = ev.message;
    }
  };

  const result = autoCompactIfUnderPressure(mockLoop, { thresholdFraction: 0.5, minMessages: 5 });
  assert.ok(result);
  assert.equal(result.compacted, true);
  assert.equal(saved, true);
  assert.ok(statusEmitted.includes('Context auto-compacted'));
});
