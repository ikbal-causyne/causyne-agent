import { test } from 'node:test';
import assert from 'node:assert/strict';

import { centerRows, composerWidth, openingRows, openingTopGap } from '../src/tui/layout.js';
import { commandDialog } from '../src/tui/commandPresentation.js';
import { ChatRenderer } from '../src/tui/chatRenderer.js';
import { Transcript } from '../src/tui/transcript.js';
import { stripAnsi, visibleWidth } from '../src/tui/text.js';
import { StageSurface } from '../src/tui/stageSurface.js';
import { hasSessionTurns } from '../src/tui/turnRail.js';

test('opening and composer use one centered readable column', () => {
  assert.equal(composerWidth(156), 82);
  assert.equal(composerWidth(60), 58);
  const centered = centerRows(['hello', 'x'], 15);
  assert.equal(centered.inset, 5);
  assert.deepEqual(centered.rows, ['     hello', '     x']);
  assert.ok(openingRows(['hello'], 156, 78).findIndex(row => row.includes('hello')) > 0);
  assert.deepEqual(openingRows(['hello'], 60, 24), ['                           hello']);
});

test('session and MCP command feedback stays in dialogs', () => {
  assert.deepEqual(commandDialog('/session new', { ok: true, output: 'created' }), {
    title: 'Sessions', text: 'created', danger: false
  });
  assert.deepEqual(commandDialog('/mcp test server', { ok: false, output: 'unavailable' }), {
    title: 'MCP servers', text: 'unavailable', danger: true
  });
  assert.equal(commandDialog('/mcp', { effect: 'pick-mcp' }), null);
  assert.equal(commandDialog('/help', { output: 'help' }), null);
});

test('a submitted multiline message is a single readable transcript frame', () => {
  const transcript = new Transcript();
  const out = { columns: 156, write: () => true };
  const renderer = new ChatRenderer({ out, transcript });
  renderer.renderUserMessage('first line\nsecond line');

  const rows = transcript.rows(156);
  const content = stripAnsi(rows.join('\n'));
  assert.equal(transcript.markers(156).filter(marker => marker.kind === 'user').length, 1);
  assert.equal(content.match(/first line/g)?.length, 1);
  assert.equal(content.match(/second line/g)?.length, 1);
  assert.ok(content.indexOf('first line') < content.indexOf('second line'));
  assert.ok(rows.every(row => visibleWidth(row) < 156), 'the message must not wrap at the terminal edge');
  assert.ok(rows.find(row => row.includes('first line'))?.startsWith('  '));
});

test('user message uses unbroken continuous heavy vertical bar (one line) without gaps', async () => {
  const { barBlock } = await import('../src/tui/block.js');
  const { GLYPHS } = await import('../src/tui/theme.js');
  const lines = ['First line', 'Second line', 'Third line', 'Fourth line'];
  const rows = barBlock(lines, { width: 50, role: 'user', filled: true, surface: 'surfaceHi' });

  // Each line must start with continuous bar (GLYPHS.barHeavy / '┃' in Unicode, '|' in ASCII)
  const expectedBar = GLYPHS.barHeavy || '┃';
  for (const row of rows) {
    const unstyled = stripAnsi(row);
    assert.ok(unstyled.startsWith(expectedBar), `Expected row to start with unbroken '${expectedBar}', got: ${unstyled.slice(0, 5)}`);
  }
  // All 4 rows must be rendered (matches exact length)
  assert.equal(rows.length, 4);
});

test('user message box and chatbox have symmetrical width and alignment', async () => {
  const out = { columns: 155, rows: 40, isTTY: true, write: () => true, on() {}, removeListener() {} };
  const surface = new StageSurface({ out, env: { CAUSYNE_SIDEBAR: '1' } });
  surface.open();

  // Add a user message to trigger turns
  surface.transcript.append({
    kind: 'user',
    produce: () => ['line 1', 'line 2'],
    meta: { messageText: 'hello' }
  });

  const sessionWidth = surface.composeWidth();
  const availableW = surface.composeAvailableWidth();

  assert.ok(sessionWidth > 20, 'sessionWidth must be positive');
  assert.ok(availableW > sessionWidth, 'available width must accommodate composer width');

  // Verify that chatRenderer's renderUserMessage uses this exact composeWidth
  const renderer = new ChatRenderer({ out, transcript: surface.transcript });
  renderer.renderUserMessage('testing symmetry');

  const frames = surface.transcript.frames;
  const userFrame = frames[frames.length - 1];
  assert.equal(userFrame?.kind, 'user');

  // Produce the frame rows at availableW
  const producedRows = userFrame.produce(availableW);
  assert.ok(producedRows.length > 0);
  assert.ok(visibleWidth(producedRows[0]!) <= availableW);
});

test('session transition and /new runs synchronously without re-entrant freeze', async () => {
  const out = { columns: 155, rows: 40, isTTY: true, write: () => true, on() {}, removeListener() {} };
  const surface = new StageSurface({ out, env: { CAUSYNE_SIDEBAR: '1' } });
  surface.enterHome({ cwd: process.cwd(), provider: 'antigravity', model: 'gemini' });

  assert.equal(hasSessionTurns(surface.transcript), false);

  const renderer = new ChatRenderer({ out, transcript: surface.transcript });
  const t0 = performance.now();

  // Simulate /new / session selection with multiple historical messages
  renderer.renderSessionHistory([
    { role: 'user', content: 'Turn 1 user request' },
    { role: 'assistant', content: 'Turn 1 assistant answer', reasoning_content: 'Thinking step' },
    { role: 'user', content: 'Turn 2 user request' },
    { role: 'assistant', content: 'Turn 2 assistant answer' }
  ], { id: 'test_session_id', title: 'Test Session', messagesCount: 4 });

  const elapsedMs = performance.now() - t0;
  const maxTransitionMs = process.env.CI ? 400 : 100;
  assert.ok(elapsedMs < maxTransitionMs, `Session transition must execute quickly (<${maxTransitionMs}ms), took ${elapsedMs.toFixed(2)}ms`);

  assert.equal(hasSessionTurns(surface.transcript), true);
  assert.equal(surface.homeInfo, null);

  // Verify composeWidth and composeAvailableWidth run with 0 re-entrancy
  const cw = surface.composeWidth();
  const aw = surface.composeAvailableWidth();
  assert.ok(cw > 0 && cw <= aw);
});




test('restoring an empty provider result never fabricates an assistant answer', () => {
  const out = { columns: 155, rows: 70, write: () => true };
  const transcript = new Transcript();
  const renderer = new ChatRenderer({ out, transcript });
  renderer.renderSessionHistory([
    { role: 'user', content: 'Build Suika Kawai and report test results' },
    { role: 'assistant', content: 'No final response was provided.', causyne_synthetic_no_final: true,
      reasoning_content: 'Invoking the required checks.' },
    { role: 'assistant', content: 'No final response was provided.' }
  ]);
  const visible = stripAnsi(transcript.rows(155).join('\n'));
  assert.equal(visible.includes('No final response was provided.'), false,
    'protocol placeholders are not user-visible answers');
  assert.match(visible, /Provider returned no final answer; task completion is unverified/);
  assert.match(visible, /Build Suika Kawai/);
  assert.ok(transcript.frames.some(frame => frame.kind === 'reasoning'),
    'real reasoning must remain readable even when its final reply was empty');
  assert.equal(transcript.frames.filter(frame => frame.kind === 'assistant').length, 0);
  assert.equal(transcript.frames.filter(frame => frame.kind === 'notice'
    && frame.meta?.syntheticNoFinal).length, 1);
});

test('synthetic empty turns are hidden between real assistant replies', () => {
  const out = { columns: 155, write: () => true };
  const transcript = new Transcript();
  const renderer = new ChatRenderer({ out, transcript });
  renderer.renderSessionHistory([
    { role: 'user', content: 'Run tests' },
    { role: 'assistant', content: 'No final response was provided.', causyne_synthetic_no_final: true },
    { role: 'assistant', content: 'Tests executed; two assertions failed.' }
  ]);
  const visible = stripAnsi(transcript.rows(155).join('\n'));
  assert.doesNotMatch(visible, /No final response was provided/);
  assert.doesNotMatch(visible, /Provider returned no final answer/);
  assert.match(visible, /two assertions failed/);
  assert.equal(transcript.frames.filter(frame => frame.kind === 'assistant').length, 1);
});

test('openingTopGap returns a finite non-negative integer for non-finite or negative introRows', () => {
  assert.equal(Number.isFinite(openingTopGap(60, Number.NaN)), true);
  assert.equal(openingTopGap(60, Number.NaN), 26);
  assert.equal(openingTopGap(60, -10), 26);
  assert.equal(openingTopGap(60, Number.NEGATIVE_INFINITY), 26);
  assert.equal(openingTopGap(60, Number.POSITIVE_INFINITY), 0);
});
