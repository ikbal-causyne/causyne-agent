import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveRunningLightSpeed,
  runningLightWindow,
  renderRunningLight
} from '../src/tui/runningLight.js';
import { StatusLine } from '../src/tui/statusLine.js';
import {
  renderThinkingFrame,
  renderCollapsedThinkingBadge
} from '../src/tui/thinkingBox.js';
import { CodeStreamRenderer } from '../src/tui/codeStreamRenderer.js';
import { Transcript } from '../src/tui/transcript.js';
import { stripAnsi, visibleWidth } from '../src/tui/text.js';
// @ts-expect-error theme.js has no TypeScript declaration yet.
import { HAS_COLOR } from '../src/tui/theme.js';

describe('runningLight (travelling shimmer animation)', () => {
  test('resolveRunningLightSpeed returns exact step intervals for all presets', () => {
    assert.deepEqual(resolveRunningLightSpeed('off'), { shortStepMs: 0, longStepMs: 0 });
    assert.deepEqual(resolveRunningLightSpeed('slow'), { shortStepMs: 200, longStepMs: 100 });
    assert.deepEqual(resolveRunningLightSpeed('medium'), { shortStepMs: 80, longStepMs: 40 });
    assert.deepEqual(resolveRunningLightSpeed('fast'), { shortStepMs: 20, longStepMs: 10 });
  });

  test('runningLightWindow computes unidirectional sweep for short strings (len < 25)', () => {
    const text = 'working...'; // len = 10
    const len = text.length;
    const w = 5;
    const limit = len + w + 6; // 21

    // Phase 0..2: lead-in dead-zone (window is completely left of index 0)
    for (let step = 0; step < 3; step++) {
      const win = runningLightWindow(len, step * 80, 'medium');
      assert.equal(win.active, true);
      assert.equal(win.width, 5);
      assert.ok(win.start + win.width <= 0, `step ${step} must be in lead-in dead-zone`);
    }

    // Phase 4: window right edge enters index 0 (start = -4, start + width = 1)
    const enterWin = runningLightWindow(len, 4 * 80, 'medium');
    assert.equal(enterWin.start, -4);
    assert.equal(enterWin.start + enterWin.width, 1);

    // Phase 8: window is fully inside string [0..5)
    const fullWin = runningLightWindow(len, 8 * 80, 'medium');
    assert.equal(fullWin.start, 0);
    assert.equal(fullWin.width, 5);

    // Phase 17: trailing edge touches last char index 9 (start = 9)
    const exitWin = runningLightWindow(len, 17 * 80, 'medium');
    assert.equal(exitWin.start, 9);

    // Phase 18..20: lead-out dead-zone (window start >= len)
    for (let step = 18; step < limit; step++) {
      const win = runningLightWindow(len, step * 80, 'medium');
      assert.ok(win.start >= len, `step ${step} must be in lead-out dead-zone`);
    }

    // Phase 21 wraps cleanly back to phase 0
    assert.deepEqual(
      runningLightWindow(len, limit * 80, 'medium'),
      runningLightWindow(len, 0, 'medium')
    );
  });

  test('runningLightWindow computes bidirectional ping-pong sweep for long strings (len >= 25)', () => {
    const text = 'Analyzing workspace & building context...'; // len = 41
    const len = text.length;
    const w = 5;
    const span = len + w; // 46
    const limit = span + 6; // 52
    const halfPeriod = span + 5; // 51
    const fullPeriod = halfPeriod * 2; // 102

    let prevStart = runningLightWindow(len, 0, 'medium').start;
    for (let step = 1; step <= fullPeriod; step++) {
      const win = runningLightWindow(len, step * 40, 'medium');
      assert.equal(win.active, true);
      assert.equal(win.width, 5);
      // Ping-pong sweep never jumps by more than 1 character between adjacent steps
      assert.ok(
        Math.abs(win.start - prevStart) <= 1,
        `smooth ping-pong invariant violated at step ${step}: ${prevStart} -> ${win.start}`
      );
      prevStart = win.start;
    }

    // Verify forward pass moves right and reverse pass moves left
    const forwardMid = runningLightWindow(len, 20 * 40, 'medium').start;
    const forwardNext = runningLightWindow(len, 21 * 40, 'medium').start;
    assert.equal(forwardNext, forwardMid + 1);

    const reverseMid = runningLightWindow(len, (limit + 10) * 40, 'medium').start;
    const reverseNext = runningLightWindow(len, (limit + 11) * 40, 'medium').start;
    assert.equal(reverseNext, reverseMid - 1);
  });

  test('renderRunningLight strictly preserves visibleWidth and stripAnsi across all phases', () => {
    const samples = [
      'working...',
      'thinking…',
      'analyzing…',
      'Analyzing & planning…',
      'The initial assessment requires differentiating between user intent and workspace constraints.',
      '▸ antigravity read_file /workspace/src/tui/thinkingBox.ts'
    ];

    for (const sample of samples) {
      const expectedWidth = visibleWidth(sample);
      for (let nowMs = 0; nowMs <= 3200; nowMs += 40) {
        const rendered = renderRunningLight(sample, { nowMs, baseRole: 'muted' });
        assert.equal(stripAnsi(rendered), sample);
        assert.equal(visibleWidth(rendered), expectedWidth);
      }
    }
  });

  test('StatusLine.render applies running-light shimmer and triggers onTick while preserving exact width', () => {
    const status = new StatusLine();
    status.setSession({ model: 'Gemini 3.8 Flash (High)' });

    const observedTicks: Array<{ nowMs: number; tick: number | undefined }> = [];
    status.onTick = (nowMs, tick) => {
      observedTicks.push({ nowMs, tick });
    };

    const frames: string[] = [];
    for (let tick = 0; tick < 12; tick++) {
      const line = status.render({
        message: 'Analyzing & planning…',
        elapsedMs: tick * 80,
        steps: 2,
        width: 90,
        spinnerFrame: '⠋',
        tick
      });
      frames.push(line);
      assert.equal(visibleWidth(line), 89);
      assert.match(stripAnsi(line), /Analyzing & planning/);
    }

    assert.equal(observedTicks.length, 12);
    assert.equal(observedTicks[5]?.nowMs, 400);
    assert.equal(observedTicks[5]?.tick, 5);

    if (HAS_COLOR) {
      // Different ticks must produce distinct ANSI highlight positions along the message
      const uniqueAnsiFrames = new Set(frames);
      assert.ok(uniqueAnsiFrames.size > 3, 'status line shimmer must animate across ticks');
    }
  });

  test('thinkingBox shimmers active header and tail thought line during streaming and stays static when completed', () => {
    const content = [
      'Inspecting project structure and dependencies',
      'Checking TypeScript compiler configuration',
      'Synthesizing optimal running-light architecture'
    ].join('\n');

    const streamingFramesAtT1 = renderThinkingFrame(content, {
      width: 80,
      streaming: true,
      activity: 'analyzing',
      durationText: '0.4s',
      nowMs: 320
    });
    const streamingFramesAtT2 = renderThinkingFrame(content, {
      width: 80,
      streaming: true,
      activity: 'analyzing',
      durationText: '0.4s',
      nowMs: 640
    });

    assert.equal(streamingFramesAtT1.length, streamingFramesAtT2.length);
    for (let i = 0; i < streamingFramesAtT1.length; i++) {
      assert.equal(visibleWidth(streamingFramesAtT1[i]!), 80);
      assert.equal(visibleWidth(streamingFramesAtT2[i]!), 80);
      assert.equal(stripAnsi(streamingFramesAtT1[i]!), stripAnsi(streamingFramesAtT2[i]!));
    }

    if (HAS_COLOR) {
      // Top border ("analyzing…") and active tail row ("Synthesizing optimal...") must animate
      assert.notEqual(streamingFramesAtT1[0], streamingFramesAtT2[0], 'top border activeLabel must shimmer');
      const tailRowIdx = streamingFramesAtT1.length - 2;
      assert.notEqual(
        streamingFramesAtT1[tailRowIdx],
        streamingFramesAtT2[tailRowIdx],
        'active streaming tail line must shimmer'
      );
      // Earlier settled thought rows remain calm/static dim
      assert.equal(
        streamingFramesAtT1[1],
        streamingFramesAtT2[1],
        'settled earlier thought rows must remain static'
      );
    }

    // Collapsed streaming badge shimmers across timestamps
    const badgeT1 = renderCollapsedThinkingBadge({ streaming: true, activity: 'thinking', nowMs: 320 }, 3);
    const badgeT2 = renderCollapsedThinkingBadge({ streaming: true, activity: 'thinking', nowMs: 560 }, 3);
    assert.equal(stripAnsi(badgeT1), stripAnsi(badgeT2));
    if (HAS_COLOR) {
      assert.notEqual(badgeT1, badgeT2, 'collapsed streaming badge must shimmer');
    }
  });

  test('CodeStreamRenderer synchronizes streaming thinking box shimmer with status line ticks and preserves status across mid-turn events', () => {
    const transcript = new Transcript();
    const statusChanges: string[] = [];
    const renderer = new CodeStreamRenderer({
      transcript,
      quietStatus: true,
      onStatusChange: (msg: string) => {
        statusChanges.push(msg);
      }
    });

    // 1. Status and activity arrive at start of model call
    renderer.handle({ type: 'status', message: 'Analyzing & planning…' });
    renderer.handle({ type: 'agent_activity', activity: 'Analyzing & planning…' });
    assert.equal(statusChanges.at(-1), 'Analyzing & planning…', 'agent_activity must not wipe active status');

    // 2. Streaming reasoning starts
    renderer.handle({
      type: 'agent_reasoning',
      content: 'First line of reasoning\nSecond active line being analyzed right now',
      streaming: true,
      elapsedMs: 320
    });
    assert.equal(statusChanges.at(-1), 'Analyzing & planning…', 'streaming reasoning must preserve active status');

    const rowsAt320 = transcript.rows(80).slice();

    // 3. Status line renders next tick at 640ms -> automatically advances streaming thinking frame shimmer
    (renderer as any).status.render({
      message: 'Analyzing & planning…',
      elapsedMs: 640,
      steps: 1,
      width: 80,
      spinnerFrame: '⠋',
      tick: 8
    });

    const rowsAt640 = transcript.rows(80).slice();
    assert.equal(rowsAt320.length, rowsAt640.length);
    if (HAS_COLOR) {
      assert.notDeepEqual(rowsAt320, rowsAt640, 'status tick must advance shimmer in active streaming thinking box');
    }
  });
});
