import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanToolOutputPreview, normalizeHistoricalToolResult } from '../src/tui/toolOutputNormalizer.ts';
import { formatMarkdownMath } from '../src/tui/markdownMath.ts';
import { ChatRenderer } from '../src/tui/chatRenderer.js';
import { Transcript } from '../src/tui/transcript.js';
import { stripAnsi } from '../src/tui/text.js';
import { pruneStaleToolObservations, shortenOversizedToolObservations } from '../src/historyPruner.ts';
import { sanitizeSequences } from '../src/contextManager.js';
import { AgentLoop } from '../src/agentLoop.js';

test('cleanToolOutputPreview strips ToolOutputStore headers, decay markers, and middle-omission notices', () => {
  const spillDoc = [
    '=== CAUSYNE TOOL OUTPUT (full, untruncated) ===',
    'tool : fs_read',
    'task : cli_chat_123   step: 3',
    'saved: 2026-11-02T21:18:50.181Z',
    '',
    'success: true',
    '',
    '--- field: output (14992 chars) ---',
    '<!DOCTYPE html>',
    '<html lang="en">',
    '[... Causyne ToolOutputStore: 241 lines (15 KB) truncated. Content Hash: 18c4061bb039 ...]',
    '[... Full log persisted to: /tmp/test.log ...]',
    '[... Read or search a relevant range with fs_read or code_search_ripgrep; do not rerun the original tool ...]',
    '[629 middle characters omitted from active context. The full output is still on disk at /tmp/test.log — read or search that file instead of re-running the tool.]',
    '</html>'
  ].join('\n');

  const cleaned = cleanToolOutputPreview(spillDoc, 'fs_read');
  assert.equal(cleaned, '<!DOCTYPE html>\n<html lang="en">\n</html>');
  assert.equal(cleanToolOutputPreview('[decayed] fs_read: reported success.', 'fs_read'), '');
  assert.equal(cleanToolOutputPreview('0/4 completed; in progress: step 1', 'update_plan'), '');

  // Glued stdout URL + stderr status label (e.g. vercel --prod) and CSI line-erase overwrites
  const vercelRaw = [
    'Production: https://suika-game-oyk8x07kj-ikbals-projects-ab6da137.vercel.app [952ms]',
    'Building...',
    'https://suika-game-oyk8x07kj-ikbals-projects-ab6da137.vercel.appProduction: https://suika-game-oyk8x07kj-ikbals-projects-ab6da137.vercel.app [5s]',
    'Completing...'
  ].join('\n');
  const vercelCleaned = cleanToolOutputPreview(vercelRaw, 'sysRun');
  assert.equal(
    vercelCleaned.includes('vercel.appProduction:'),
    false,
    'Glued stdout URL and stderr Production: status must be split onto separate lines'
  );
  assert.match(
    vercelCleaned,
    /https:\/\/suika-game-oyk8x07kj-ikbals-projects-ab6da137\.vercel\.app\nProduction: https:\/\/suika-game-oyk8x07kj-ikbals-projects-ab6da137\.vercel\.app \[5s\]/
  );
});

test('formatMarkdownMath and ChatRenderer convert LaTeX math to readable Unicode while preserving prices and code spans', () => {
  const sample = 'slack variables ($\\sigma_i \\in [0, 1]$), isotropic scaling $s = \\min(W_{\\text{avail}} / W_0, H_{\\text{avail}} / H_0)$, and Fitts Law ($ID < 1.15\\text{ bits}$) costing $100 with `$HOME` intact.';
  const formatted = formatMarkdownMath(sample);
  assert.match(formatted, /σ_i ∈ \[0, 1\]/);
  assert.match(formatted, /s = min\(W_avail \/ W_0, H_avail \/ H_0\)/);
  assert.match(formatted, /\(ID < 1\.15 bits\)/);
  assert.match(formatted, /\$100/);

  const transcript = new Transcript();
  const renderer = new ChatRenderer({ transcript });
  renderer.onAgentMessage({ content: sample, streaming: false });
  const flat = transcript.flatten(120).rows.map((r: string) => stripAnsi(r)).join('\n');
  assert.equal(flat.includes('\\sigma_i'), false);
  assert.equal(flat.includes('\\text{avail}'), false);
  assert.equal(flat.includes('σ_i ∈ [0, 1]'), true);
  assert.equal(flat.includes('$HOME'), true);
});

test('renderSessionHistory suppresses [decayed] prompt strings, synthesis checkpoints, and orphan update_plan steps', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-tui-history-'));
  const spillFile = path.join(tmpDir, 'index_spill.log');
  fs.writeFileSync(
    spillFile,
    [
      '=== CAUSYNE TOOL OUTPUT (full, untruncated) ===',
      'tool : fs_read',
      'task : test   step: 1',
      'saved: 2026-11-02T21:18:50.181Z',
      '',
      'success: true',
      '',
      '--- field: output (120 chars) ---',
      '<!DOCTYPE html>',
      '<title>Suika Kawaii</title>'
    ].join('\n'),
    'utf8'
  );

  try {
    const transcript = new Transcript();
    const renderer = new ChatRenderer({ transcript });

    const messages = [
      { role: 'user', content: 'Fix mobile UI layout' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_plan',
            type: 'function',
            function: {
              name: 'update_plan',
              arguments: JSON.stringify({
                explanation: 'Plan UI fix',
                plan: [
                  { id: '1', step: 'Inspect files', status: 'in_progress' },
                  { id: '2', step: 'Implement solver', status: 'pending' }
                ]
              })
            }
          },
          {
            id: 'call_read_1',
            type: 'function',
            function: {
              name: 'fs_read',
              arguments: JSON.stringify({ path: '/app/index.html' })
            }
          },
          {
            id: 'call_read_synth',
            type: 'function',
            function: {
              name: 'fs_read',
              arguments: JSON.stringify({ path: '/app/game.js' })
            }
          }
        ]
      },
      {
        role: 'tool',
        tool_call_id: 'call_plan',
        name: 'update_plan',
        content: '[decayed] update_plan: reported success. Earlier output (933 characters) was cleared from context. The full output is still on disk at /tmp/nonexistent_plan.txt — read or search that file instead of re-running the tool.'
      },
      {
        role: 'tool',
        tool_call_id: 'call_read_1',
        name: 'fs_read',
        content: `[decayed] fs_read: outcome unverified. Earlier output (2265 characters) was cleared from context. The full output is still on disk at ${spillFile} — read or search that file instead of re-running the tool.`,
        spillPath: spillFile
      },
      {
        role: 'tool',
        tool_call_id: 'call_read_synth',
        name: 'fs_read',
        content: JSON.stringify({
          success: false,
          checkpoint: 'synthesis',
          error: 'Inspection batch complete (2 actions). Synthesize the observations before another batch.'
        })
      },
      {
        role: 'tool',
        tool_call_id: 'orphan_plan',
        name: 'update_plan',
        content: '[decayed] update_plan: reported success. Earlier output (680 characters) was cleared from context. The full output is still on disk at /tmp/orphan.txt — read or search that file instead of re-running the tool.'
      }
    ];

    renderer.renderSessionHistory(messages, { id: 's_test', title: 'Mobile UI' });
    const flat = transcript.flatten(100).rows.map((r: string) => stripAnsi(r)).join('\n');

    assert.equal(flat.includes('[decayed]'), false, 'Must never render raw [decayed] prompt text in TUI');
    assert.equal(flat.includes('Inspection batch complete'), false, 'Must skip internal synthesis checkpoints');
    assert.equal(flat.includes('<title>Suika Kawaii</title>'), true, 'Must recover clean preview from spill file');

    const stepFrames = transcript.frames.filter((f: { kind: string }) => f.kind === 'step');
    assert.equal(stepFrames.length, 2, 'Should render only call_plan and call_read_1, skipping synthesis checkpoint and orphan decayed update_plan');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('shortenOversizedToolObservations preserves valid JSON and verdictFor reports success after shortening', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-json-shorten-'));
  const prevHome = process.env.CAUSYNE_HOME;
  process.env.CAUSYNE_HOME = tmpHome;
  try {
    const messages = [
      {
        role: 'tool',
        name: 'fs_read',
        tool_call_id: 'c1',
        content: JSON.stringify({ success: true, output: 'line 1\n' + 'x'.repeat(5000) + '\nline end' })
      },
      {
        role: 'tool',
        name: 'fs_read',
        tool_call_id: 'c2',
        content: JSON.stringify({ success: true, output: 'recent' })
      }
    ];

    shortenOversizedToolObservations(messages, { taskId: 'json_shorten', threshold: 2500 });
    const parsedAfterShorten = JSON.parse(String(messages[0]?.content));
    assert.equal(parsedAfterShorten.success, true);

    pruneStaleToolObservations(messages, { taskId: 'json_shorten', keepRecent: 1 });
    assert.match(String(messages[0]?.content), /reported success/);
    assert.doesNotMatch(String(messages[0]?.content), /outcome unverified/);
  } finally {
    if (prevHome === undefined) delete process.env.CAUSYNE_HOME;
    else process.env.CAUSYNE_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('advanceImplementationPlanProgress does not jump explicit plan to verification before mutation', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-plan-guard-'));
  try {
    const loop = new AgentLoop({ readyState: 1, send: () => {} }, 'plan-guard', 'Fix mobile UI', { workspaceRoot: workspace });
    loop.updateImplementationPlan({
      explanation: 'Explicit 3-step plan',
      plan: [
        { id: '1', step: 'Inspect mobile UI via browser_act', status: 'in_progress' },
        { id: '2', step: 'Re-engineer CSS and layout solver', status: 'pending' },
        { id: '3', step: 'Verify and deploy', status: 'pending' }
      ]
    });

    // Initial pre-mutation browser_act inspection must not jump to step 3
    loop.advanceImplementationPlanProgress('verification');
    assert.equal(loop._implementationPlan[0]?.status, 'in_progress');
    assert.equal(loop._implementationPlan[1]?.status, 'pending');
    assert.equal(loop._implementationPlan[2]?.status, 'pending');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('sanitizeSequences drops orphan tool messages whose tool_call_id does not belong to the preceding assistant', () => {
  const messages = [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'tool_search', arguments: '{}' } }]
    },
    { role: 'tool', tool_call_id: 'call_a', name: 'tool_search', content: '{"success":true}' },
    { role: 'tool', tool_call_id: 'orphan_from_dropped_turn', name: 'update_plan', content: '[decayed] update_plan' }
  ];

  const cleaned = sanitizeSequences(messages);
  assert.equal(cleaned.length, 2);
  assert.equal(cleaned[1]?.tool_call_id, 'call_a');
});

test('formatMarkdownMath ignores Object.prototype macro keys and avoids ReDoS on unclosed display delimiters', () => {
  const protoText = formatMarkdownMath('$\\toString + \\constructor$');
  assert.equal(protoText.includes('function'), false, 'prototype keys must not stringify functions into output');
  assert.equal(protoText, '\\toString + \\constructor');

  const start = Date.now();
  const adversarial = '$$' + '\\'.repeat(4000) + '$$ $$' + 'a$'.repeat(400);
  const out = formatMarkdownMath(adversarial);
  assert.ok(Date.now() - start < 200, 'formatMarkdownMath must complete linearly without regex backtracking');
  assert.equal(typeof out, 'string');
});

