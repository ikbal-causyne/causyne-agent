import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderThinkingFrame,
  renderCollapsedThinkingBadge,
  buildThinkingBoxBorders,
  DEFAULT_MAX_STREAMING_LINES,
  DEFAULT_MAX_EXPANDED_LINES
} from '../src/tui/thinkingBox.js';
import { stripAnsi, visibleWidth } from '../src/tui/text.js';

describe('thinkingBox component', () => {
  test('returns empty array for empty reasoning content', () => {
    assert.deepEqual(renderThinkingFrame(''), []);
    assert.deepEqual(renderThinkingFrame('   \n  '), []);
  });

  test('collapsed badge formats for streaming mode', () => {
    const badge = renderCollapsedThinkingBadge({ streaming: true, durationText: '2.4s' }, 15);
    const plain = stripAnsi(badge);
    assert.match(plain, /thinking…/);
    assert.match(plain, /2\.4s/);
    assert.match(plain, /click to expand/);
  });

  test('collapsed badge formats for completed mode', () => {
    const badge = renderCollapsedThinkingBadge({ streaming: false, durationText: '3.1s' }, 42);
    const plain = stripAnsi(badge);
    assert.match(plain, /Thought for 3\.1s/);
    assert.match(plain, /\(42 lines\)/);
    assert.match(plain, /click to expand/);
  });

  test('renderThinkingFrame returns 1 row when collapsed is true', () => {
    const content = Array.from({ length: 20 }, (_, i) => `Step ${i + 1}`).join('\n');
    const rows = renderThinkingFrame(content, { collapsed: true, durationText: '1.5s' });
    assert.equal(rows.length, 1);
    assert.match(stripAnsi(rows[0] ?? ''), /Thought for 1\.5s/);
    assert.match(stripAnsi(rows[0] ?? ''), /click to expand/);
  });

  test('renderThinkingFrame builds a complete bordered box with exact visible widths', () => {
    const width = 80;
    const content = ['Analyzing schema requirements', 'Validating tool dependencies', 'Ready to proceed'].join('\n');
    const rows = renderThinkingFrame(content, { width, streaming: false, durationText: '0.8s' });

    assert.ok(rows.length >= 5);
    // Verify every single row matches width exactly
    for (let i = 0; i < rows.length; i++) {
      assert.equal(
        visibleWidth(rows[i] ?? ''),
        width,
        `Row ${i} ("${stripAnsi(rows[i] ?? '')}") visibleWidth must be ${width}`
      );
    }

    const plainFirst = stripAnsi(rows[0] ?? '');
    const plainLast = stripAnsi(rows[rows.length - 1] ?? '');
    assert.match(plainFirst, /thinking/);
    assert.match(plainLast, /click to collapse/);
  });

  test('streaming auto-scroll pins to newest lines and shows scrolled indicator', () => {
    const width = 90;
    const lines = Array.from({ length: 30 }, (_, i) => `Thinking thought ${i + 1}`);
    const content = lines.join('\n');

    const rows = renderThinkingFrame(content, {
      width,
      streaming: true,
      durationText: '4.5s',
      maxVisibleLines: DEFAULT_MAX_STREAMING_LINES
    });

    const plainText = rows.map(r => stripAnsi(r)).join('\n');
    assert.match(plainText, /earlier thinking lines scrolled/);
    assert.match(plainText, /Thinking thought 30/, 'latest streamed line must be visible');
    assert.ok(!plainText.includes('Thinking thought 1\n'), 'oldest lines must have scrolled out of streaming view');

    for (let i = 0; i < rows.length; i++) {
      assert.equal(visibleWidth(rows[i] ?? ''), width, `Row ${i} must have exact width ${width}`);
    }
  });

  test('completed expanded view shows capped head and scroll indicator with interactive offset', () => {
    const width = 84;
    const lines = Array.from({ length: 25 }, (_, i) => `Completed step ${i + 1}`);
    const content = lines.join('\n');

    // 1. Initial view at start = 0
    const rowsInitial = renderThinkingFrame(content, {
      width,
      streaming: false,
      durationText: '2.2s',
      maxVisibleLines: DEFAULT_MAX_EXPANDED_LINES,
      startLine: 0
    });

    const plainInitial = rowsInitial.map(r => stripAnsi(r)).join('\n');
    assert.match(plainInitial, /Completed step 1/);
    assert.match(plainInitial, /Completed step 12/);
    assert.match(plainInitial, /lines 1–12 of 25.*scroll over thinking/);

    for (let i = 0; i < rowsInitial.length; i++) {
      assert.equal(visibleWidth(rowsInitial[i] ?? ''), width, `Row ${i} must have exact width ${width}`);
    }

    // 2. Scrolled down view at start = 10
    const rowsScrolled = renderThinkingFrame(content, {
      width,
      streaming: false,
      durationText: '2.2s',
      maxVisibleLines: DEFAULT_MAX_EXPANDED_LINES,
      startLine: 10
    });

    const plainScrolled = rowsScrolled.map(r => stripAnsi(r)).join('\n');
    assert.match(plainScrolled, /Completed step 11/);
    assert.match(plainScrolled, /Completed step 22/);
    assert.match(plainScrolled, /lines 11–22 of 25.*scroll over thinking/);

    // 3. Scrolled to the bottom boundary at start = 13 (limit = 25 - 12 = 13)
    const rowsBottom = renderThinkingFrame(content, {
      width,
      streaming: false,
      durationText: '2.2s',
      maxVisibleLines: DEFAULT_MAX_EXPANDED_LINES,
      startLine: 999 // clamped to limit
    });

    const plainBottom = rowsBottom.map(r => stripAnsi(r)).join('\n');
    assert.match(plainBottom, /Completed step 14/);
    assert.match(plainBottom, /Completed step 25/);
    assert.match(plainBottom, /lines 14–25 of 25/);
  });

  test('buildThinkingBoxBorders guarantees exact column width', () => {
    for (const width of [40, 60, 80, 100, 120]) {
      const { top, bottom, wrapRow } = buildThinkingBoxBorders('test title', 'test footer', width);
      assert.equal(visibleWidth(top), width);
      assert.equal(visibleWidth(bottom), width);
      assert.equal(visibleWidth(wrapRow('sample text')), width);
    }
  });

  test('handleMessageMouse toggles collapsed state when reasoning frame is clicked', async () => {
    const { handleMessageMouse } = await import('../src/tui/messageInteraction.js');
    const { Transcript } = await import('../src/tui/transcript.js');

    const transcript = new Transcript();
    const frameId = transcript.append({
      kind: 'reasoning',
      meta: { reasoning: true, collapsed: false, content: 'thinking step' },
      produce: () => ['reasoning line']
    });

    let scheduled = false;
    const surface = {
      width: 80,
      out: { rows: 24 },
      stage: { height: 20, reserved: true },
      viewport: { height: 18, width: 80, scrollTop: 0 },
      transcript,
      hoveredMessageFrameId: null,
      turnRailLayout: null
    };

    const host = {
      surface,
      busy: false,
      notice: '',
      openLayer: () => {},
      scheduleDraw: () => { scheduled = true; }
    };

    const frame = transcript.frames.find((f: any) => f.id === frameId);
    assert.equal(frame?.meta?.collapsed, false);

    // Click on row 0 of transcript
    const handled = handleMessageMouse(host as any, null, {
      mouse: { x: 10, y: 4 + 17, button: 0, pressed: true } // y top is 4, viewRow is 17 (padding is 17, row is 0)
    });

    assert.equal(handled, true);
    assert.equal(frame?.meta?.collapsed, true, 'frame must be collapsed after click');
    assert.equal(scheduled, true, 'scheduleDraw must be triggered');

    // Click again to toggle back to expanded
    scheduled = false;
    handleMessageMouse(host as any, null, {
      mouse: { x: 10, y: 4 + 17, button: 0, pressed: true }
    });
    assert.equal(frame?.meta?.collapsed, false, 'frame must be expanded after second click');
    assert.equal(scheduled, true);
  });

  test('/thinking slash command toggles and configures reasoning frames', async () => {
    const { COMMANDS } = await import('../src/commands.js');
    const { Transcript } = await import('../src/tui/transcript.js');

    const thinkingCmd = COMMANDS.find((c: any) => c.name === 'thinking');
    assert.ok(thinkingCmd, '/thinking command must be registered');

    const transcript = new Transcript();
    transcript.append({
      kind: 'reasoning',
      meta: { reasoning: true, collapsed: false, content: 'thought 1' },
      produce: () => ['thought 1']
    });
    transcript.append({
      kind: 'reasoning',
      meta: { reasoning: true, collapsed: false, content: 'thought 2' },
      produce: () => ['thought 2']
    });

    let scheduled = false;
    const ctx = {
      prompt: {
        surface: { transcript },
        scheduleDraw: () => { scheduled = true; }
      }
    };

    // 1. Toggle collapse
    const res1 = thinkingCmd.run([], ctx);
    assert.match(res1.output, /Collapsed 2 thinking frames/);
    assert.equal(transcript.frames[0]?.meta?.collapsed, true);
    assert.equal(transcript.frames[1]?.meta?.collapsed, true);

    // 2. Expand explicit
    const res2 = thinkingCmd.run(['expand'], ctx);
    assert.match(res2.output, /Expanded 2 thinking frames/);
    assert.equal(transcript.frames[0]?.meta?.collapsed, false);
    assert.equal(transcript.frames[1]?.meta?.collapsed, false);

    // 3. Collapse explicit
    const res3 = thinkingCmd.run(['collapse'], ctx);
    assert.match(res3.output, /Collapsed 2 thinking frames/);
    assert.equal(transcript.frames[0]?.meta?.collapsed, true);
  });

  test('scrollThinkingPanel handles mouse wheel up/down over reasoning frames', async () => {
    const { CodeStreamRenderer } = await import('../src/tui/codeStreamRenderer.js');
    const { Transcript } = await import('../src/tui/transcript.js');

    const renderer = new CodeStreamRenderer();
    const transcript = new Transcript();
    renderer.transcript = transcript as any;

    const longReasoning = Array.from({ length: 30 }, (_, i) => `Reasoning line ${i + 1}`).join('\n');
    renderer.onAgentReasoning({ content: longReasoning, streaming: false, collapsed: false, elapsedMs: 1200 });

    const frame = transcript.frames[0];
    assert.ok(frame, 'reasoning frame must be created');
    assert.equal(frame.meta?.reasoning, true);
    assert.equal(frame.meta?.scrollStart, 0);

    const surface = {
      out: { rows: 24 },
      stage: { height: 20 },
      viewport: { viewWidth: 80, viewHeight: 18, scrollTop: 0 }
    };

    // 1. Wheel down over thinking frame -> increases scrollStart by 3
    const handledDown1 = renderer.scrollThinkingPanel({
      name: 'wheel',
      wheel: { direction: 'down', x: 10, y: 5 } // y=5 is screenTop(4) + localY(1) = inside frame
    }, surface as any);

    assert.equal(handledDown1, true);
    assert.equal(frame.meta?.scrollStart, 3);

    // 2. Wheel down again -> scrollStart becomes 6
    const handledDown2 = renderer.scrollThinkingPanel({
      name: 'wheel',
      wheel: { direction: 'down', x: 10, y: 5 }
    }, surface as any);
    assert.equal(handledDown2, true);
    assert.equal(frame.meta?.scrollStart, 6);

    // 3. Wheel up -> scrollStart decreases back to 3
    const handledUp = renderer.scrollThinkingPanel({
      name: 'wheel',
      wheel: { direction: 'up', x: 10, y: 5 }
    }, surface as any);
    assert.equal(handledUp, true);
    assert.equal(frame.meta?.scrollStart, 3);

    // 4. Pointer outside thinking box -> returns false so viewport handles it
    const handledOutside = renderer.scrollThinkingPanel({
      name: 'wheel',
      wheel: { direction: 'down', x: 10, y: 22 } // below viewport viewHeight (18)
    }, surface as any);
    assert.equal(handledOutside, false);

    // 5. Wide terminal with sidebar (e.g. 155x78)
    const wideSurface = {
      out: { rows: 78 },
      width: 155,
      stage: { height: 74 },
      viewport: { viewWidth: 109, viewHeight: 70, width: 109, height: 70, scrollTop: 0 }
    };
    const handledWide = renderer.scrollThinkingPanel({
      name: 'wheel',
      wheel: { direction: 'down', x: 80, y: 60 }
    }, wideSurface as any);
    assert.equal(handledWide, true, 'wheel over thinking box in wide terminal must succeed');
  });

  test('auto-collapses reasoning frame when finished streaming, allowing user click to expand/collapse', async () => {
    const { CodeStreamRenderer } = await import('../src/tui/codeStreamRenderer.js');
    const { Transcript } = await import('../src/tui/transcript.js');
    const { handleMessageMouse } = await import('../src/tui/messageInteraction.js');

    const renderer = new CodeStreamRenderer();
    const transcript = new Transcript();
    renderer.transcript = transcript as any;

    // 1. Streaming reasoning starts expanded so user sees thoughts live
    renderer.onAgentReasoning({ content: 'Analyzing problem\nEvaluating solution', streaming: true, elapsedMs: 500 });
    const frame = transcript.frames[0];
    assert.ok(frame);
    assert.equal(frame.meta?.streaming, true);
    assert.equal(frame.meta?.collapsed, false, 'streaming thinking box must be open/expanded');

    // 2. When the session turn completes (task_complete), it automatically collapses into a compact badge
    renderer.onAgentReasoning({ content: 'Analyzing problem\nEvaluating solution\nDone thinking', streaming: false, elapsedMs: 1400 });
    renderer.handle({ type: 'task_complete' });
    assert.equal(frame.meta?.streaming, false);
    assert.equal(frame.meta?.collapsed, true, 'finished session must auto-collapse thinking box');

    // Render frame and verify it yields compact badge (1 line)
    const rows = transcript.renderFrame(frame, 80);
    assert.ok(rows.length <= 3, 'collapsed badge must only take minimal compact lines');
    const badgeText = stripAnsi(rows.join('\n'));
    assert.match(badgeText, /Thought for 1\.4s/);
    assert.match(badgeText, /click to expand/);

    // 3. User clicks the collapsed badge: it expands back into the full thinking box
    let scheduled = false;
    const surface = {
      width: 80,
      out: { rows: 24 },
      stage: { height: 20, reserved: true },
      viewport: { height: 18, width: 80, scrollTop: 0 },
      transcript,
      hoveredMessageFrameId: null,
      turnRailLayout: null
    };
    const host = {
      surface,
      busy: false,
      notice: '',
      openLayer: () => {},
      scheduleDraw: () => { scheduled = true; }
    };

    const clicked = handleMessageMouse(host as any, null, {
      mouse: { x: 10, y: 4 + 17, button: 0, pressed: true }
    });
    assert.equal(clicked, true);
    assert.equal(frame.meta?.collapsed, false, 'clicking collapsed badge must expand it');
    assert.equal(frame.meta?.userInteracted, true);

    // Re-rendered rows now show the full bordered thinking box
    const expandedRows = transcript.renderFrame(frame, 80);
    assert.ok(expandedRows.length >= 5, 'expanded box must contain borders and content lines');
    const expandedText = stripAnsi(expandedRows.join('\n'));
    assert.match(expandedText, /thinking/);
    assert.match(expandedText, /click to collapse/);

    // 4. User clicks again: it collapses back
    handleMessageMouse(host as any, null, {
      mouse: { x: 10, y: 4 + 17, button: 0, pressed: true }
    });
    assert.equal(frame.meta?.collapsed, true, 'clicking expanded box must collapse it back');
  });

  test('auto-collapses active reasoning when next turn event (agent_message, step_start, task_complete) arrives', async () => {
    const { CodeStreamRenderer } = await import('../src/tui/codeStreamRenderer.js');
    const { Transcript } = await import('../src/tui/transcript.js');

    const renderer = new CodeStreamRenderer();
    const transcript = new Transcript();
    renderer.transcript = transcript as any;

    // Start streaming reasoning
    renderer.handle({
      type: 'agent_reasoning',
      content: 'Generating plan and determining steps',
      streaming: true,
      elapsedMs: 800
    });
    const frame = transcript.frames[0];
    assert.ok(frame);
    assert.equal(frame.meta?.collapsed, false);

    // Transition to agent_message without explicit streaming: false on agent_reasoning
    renderer.handle({
      type: 'agent_message',
      content: 'Here is the result:',
      streaming: false
    });

    assert.equal(frame.meta?.collapsed, true, 'transitioning to agent_message must auto-collapse reasoning frame');
    assert.equal(frame.meta?.streaming, false);
    assert.equal(frame.meta?.done, true);
  });

  test('auto-collapses reasoning frames when task completes via turnFooter', async () => {
    const { CodeStreamRenderer } = await import('../src/tui/codeStreamRenderer.js');
    const { Transcript } = await import('../src/tui/transcript.js');

    const renderer = new CodeStreamRenderer();
    const transcript = new Transcript();
    renderer.transcript = transcript as any;

    renderer.onAgentReasoning({ content: 'First thought', streaming: false, elapsedMs: 300 });
    renderer.onAgentReasoning({ content: 'Second thought', streaming: false, elapsedMs: 600 });
    assert.equal(transcript.frames.length, 2);
    assert.equal(transcript.frames[0]?.meta?.collapsed, false);
    assert.equal(transcript.frames[1]?.meta?.collapsed, false);

    // End of task in cliMode invokes turnFooter
    renderer.turnFooter(1200);

    assert.equal(transcript.frames[0]?.meta?.collapsed, true, 'all completed thinking frames must auto-collapse on turnFooter');
    assert.equal(transcript.frames[1]?.meta?.collapsed, true);
  });
});
