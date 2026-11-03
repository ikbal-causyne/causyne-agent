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

  test('completed expanded view shows capped head and footer indicator', () => {
    const width = 84;
    const lines = Array.from({ length: 25 }, (_, i) => `Completed step ${i + 1}`);
    const content = lines.join('\n');

    const rows = renderThinkingFrame(content, {
      width,
      streaming: false,
      durationText: '2.2s',
      maxVisibleLines: DEFAULT_MAX_EXPANDED_LINES
    });

    const plainText = rows.map(r => stripAnsi(r)).join('\n');
    assert.match(plainText, /Completed step 1/);
    assert.match(plainText, /more lines of reasoning/);

    for (let i = 0; i < rows.length; i++) {
      assert.equal(visibleWidth(rows[i] ?? ''), width, `Row ${i} must have exact width ${width}`);
    }
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
});
