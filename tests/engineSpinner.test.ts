import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderCausyneRotor,
  getAngle,
  getRotorSpinnerFrames,
  getRotorSpinnerFrame,
  getAnimatedDots,
  formatAnimatedStatus,
} from '../src/tui/CausyneRotor.js';
import { visibleWidth, stripAnsi } from '../src/tui/text.js';
import { GLYPHS } from '../src/tui/theme.js';
import { StatusLine } from '../src/tui/statusLine.js';

test('CausyneRotor: renderCausyneRotor draws multi-line Braille rotor with label', () => {
  const frame0 = renderCausyneRotor(0, { columns: 16, rows: 8, label: 'working' });
  assert.ok(frame0.includes('working'));
  const lines = frame0.split('\n');
  assert.equal(lines.length, 9); // 8 rows of rotor + 1 status label line

  // At different elapsed times, geometry rotates
  const frame500 = renderCausyneRotor(500, { columns: 16, rows: 8, label: 'working' });
  assert.ok(frame500.includes('working'));
  assert.notEqual(stripAnsi(frame0), stripAnsi(frame500));
});

test('CausyneRotor: getAngle handles heavy, smooth, and pulse motion curves', () => {
  const angleHeavy = getAngle(500, 'heavy');
  const angleSmooth = getAngle(500, 'smooth');
  const anglePulse = getAngle(500, 'pulse');

  assert.ok(angleHeavy >= 0);
  assert.ok(angleSmooth >= 0);
  assert.ok(anglePulse >= 0);
});

test('CausyneRotor: rotor spinner frames maintain invariant visible width', () => {
  const colorFrames = getRotorSpinnerFrames(true, true);
  const plainFrames = getRotorSpinnerFrames(false, true);
  const asciiFrames = getRotorSpinnerFrames(false, false);

  assert.equal(colorFrames.length, 6);
  assert.equal(plainFrames.length, 6);
  assert.equal(asciiFrames.length, 4);

  for (const frame of colorFrames) {
    assert.equal(visibleWidth(frame), 2);
  }
  for (const frame of plainFrames) {
    assert.equal(visibleWidth(frame), 2);
  }
  for (const frame of asciiFrames) {
    assert.equal(visibleWidth(frame), 3);
  }
});

test('CausyneRotor: animated dots cycle cleanly and maintain constant visible width', () => {
  for (let tick = 0; tick < 16; tick++) {
    const dots = getAnimatedDots(tick);
    assert.equal(visibleWidth(dots), 3, `dots visible width at tick ${tick} must be 3`);
  }

  const msg0 = formatAnimatedStatus('working', 0);
  const msg2 = formatAnimatedStatus('working', 2);
  const msg4 = formatAnimatedStatus('working', 4);
  const msg6 = formatAnimatedStatus('working', 6);

  assert.equal(msg0, 'working   ');
  assert.equal(msg2, 'working.  ');
  assert.equal(msg4, 'working.. ');
  assert.equal(msg6, 'working...');
});

test('CausyneRotor: GLYPHS.spinner integrates with theme', () => {
  assert.ok(Array.isArray(GLYPHS.spinner));
  assert.ok(GLYPHS.spinner.length >= 4);
  for (const frame of GLYPHS.spinner) {
    assert.ok(visibleWidth(frame) >= 2);
  }
});

test('CausyneRotor: statusLine renders rotor frames and animated dots', () => {
  const status = new StatusLine();
  const frame = getRotorSpinnerFrame(1);
  const line = status.render({
    message: 'working',
    elapsedMs: 3400,
    steps: 4,
    width: 80,
    spinnerFrame: frame,
    tick: 2,
  });

  assert.ok(line.includes('working.'));
  assert.ok(visibleWidth(line) <= 79);
});

test('CausyneRotor: formatAnimatedStatus falls back to working when message trims or strips to empty', () => {
  assert.equal(formatAnimatedStatus('...', 2), 'working.  ');
  assert.equal(formatAnimatedStatus('…', 4), 'working.. ');
  assert.equal(formatAnimatedStatus('   ', 6), 'working...');
});
