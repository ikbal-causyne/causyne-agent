import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getEngineFrames,
  getEngineFrame,
  detectSpinnerStyle,
  type EngineSpinnerStyle,
} from '../src/tui/engineSpinner.js';
import { visibleWidth, stripAnsi } from '../src/tui/text.js';
import { GLYPHS } from '../src/tui/theme.js';
import { StatusLine } from '../src/tui/statusLine.js';

test('engineSpinner: every style has identical visible width across all frames', () => {
  const styles: EngineSpinnerStyle[] = ['turbine', 'iris', 'reactor', 'compact', 'ascii'];

  for (const style of styles) {
    const frames = getEngineFrames({ style, unicode: style !== 'ascii' });
    assert.ok(frames.length >= 4, `style ${style} should have at least 4 frames`);

    const expectedWidth = visibleWidth(frames[0]);
    assert.ok(expectedWidth > 0, `style ${style} width must be positive`);

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      assert.ok(frame, `frame ${i} should be defined`);
      const w = visibleWidth(frame);
      assert.equal(
        w,
        expectedWidth,
        `style ${style} frame ${i} visible width (${w}) does not match expected (${expectedWidth})`
      );
    }
  }
});

test('engineSpinner: turbine mode is 4 columns wide and includes rotating blades', () => {
  const frames = getEngineFrames({ style: 'turbine', unicode: true });
  assert.equal(frames.length, 8);
  for (const frame of frames) {
    assert.equal(visibleWidth(frame), 4);
    const plain = stripAnsi(frame);
    assert.ok(plain.startsWith('◖'), `frame ${plain} should start with nacelle left`);
    assert.ok(plain.endsWith('◗'), `frame ${plain} should end with nacelle right`);
  }
});

test('engineSpinner: iris mode is 3 columns wide and has 6 blades matching Causyne logo', () => {
  const frames = getEngineFrames({ style: 'iris', unicode: true });
  assert.equal(frames.length, 6);
  for (const frame of frames) {
    assert.equal(visibleWidth(frame), 3);
    const plain = stripAnsi(frame);
    assert.ok(plain.startsWith('◖'));
    assert.ok(plain.endsWith('◗'));
  }
});

test('engineSpinner: getEngineFrame handles arbitrary and negative ticks safely', () => {
  const frame0 = getEngineFrame(0);
  const frame8 = getEngineFrame(8);
  const frameNeg = getEngineFrame(-8);
  assert.equal(visibleWidth(frame0), 4);
  assert.equal(visibleWidth(frame8), 4);
  assert.equal(visibleWidth(frameNeg), 4);
});

test('engineSpinner: GLYPHS.spinner integrates with theme', () => {
  assert.ok(Array.isArray(GLYPHS.spinner));
  assert.ok(GLYPHS.spinner.length >= 4);
  for (const frame of GLYPHS.spinner) {
    assert.ok(visibleWidth(frame) >= 3);
  }
});

test('engineSpinner: statusLine renders rich engine frames without line breakage', () => {
  const status = new StatusLine();
  const frame = getEngineFrame(1);
  const line = status.render({
    message: 'working',
    elapsedMs: 3400,
    steps: 4,
    width: 80,
    spinnerFrame: frame,
  });

  assert.ok(line.includes('working'));
  assert.ok(visibleWidth(line) <= 79);
});
