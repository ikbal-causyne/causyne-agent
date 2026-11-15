import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StageSurface } from '../src/tui/stageSurface.js';

function harness(env: Record<string, string> = {}) {
  const writes: string[] = [];
  const out = { isTTY: true, rows: 38, columns: 122,
    write(chunk: string) { writes.push(String(chunk)); return true; },
    on() {}, removeListener() {} };
  const surface = new StageSurface({ out, env });
  assert.equal(surface.open(), true);
  return { surface, out, writes };
}

test('interactive conversation dots enable hover motion and retain viewport wheel reporting after rail hides', () => {
  const { surface, out, writes } = harness();
  try {
    assert.ok(writes.join('').includes('\x1b[?1000h'));
    assert.ok(!writes.join('').includes('\x1b[?1003h'));

    surface.commit('user', () => ['user prompt'], { messageText: 'user prompt' });
    writes.length = 0;
    surface.present(['COMPOSER'], { row: 0, col: 0 });
    assert.ok(surface.turnRailLayout?.turns?.length > 0);
    assert.ok(writes.join('').includes('\x1b[?1003h'), 'turn dots should support motion hover by default');
    assert.equal(surface.mouseMotionOn, true);

    writes.length = 0;
    out.columns = 59; // Rail disappears at narrow widths.
    surface.resize();
    surface.present(['COMPOSER'], { row: 0, col: 0 });
    const output = writes.join('');
    assert.ok(output.includes('\x1b[?1003l'), 'turn hover must stop in narrow terminals');
    assert.ok(output.includes('\x1b[?1006h\x1b[?1000h'), 'ordinary wheel tracking must be rearmed');
    assert.equal(surface.mouseCaptured, true);
    assert.equal(surface.mouseMotionOn, false);

    writes.length = 0;
    surface.releaseMouse();
    assert.ok(writes.join('').includes('\x1b[?1003l'), 'release must always clean auto-hover mode');
    assert.ok(writes.join('').includes('\x1b[?1000l'), 'release must clean wheel mode');
  } finally {
    surface.close();
  }
});

test('explicit hover opt-out allows scroll but prevents 1003 even with turn dots', () => {
  const { surface, writes } = harness({ CAUSYNE_MOUSE_HOVER: '0' });
  try {
    surface.commit('user', () => ['prompt'], { messageText: 'prompt' });
    surface.present(['COMPOSER'], { row: 0, col: 0 });
    assert.equal(surface.mouseOn, true);
    assert.equal(surface.mouseMotionOn, false);
    assert.ok(!writes.join('').includes('\x1b[?1003h'));
  } finally { surface.close(); }
});

test('hover capture is disabled on Home and modal transitions', () => {
  const { surface, writes } = harness();
  try {
    surface.commit('user', () => ['prompt'], { messageText: 'prompt' });
    surface.present(['COMPOSER'], { row: 0, col: 0 });
    assert.equal(surface.mouseMotionOn, true);
    writes.length = 0;
    surface.present(['modal dialog'], { row: 0, col: 0, modal: true });
    assert.ok(writes.join('').includes('\x1b[?1003l'));
    assert.equal(surface.mouseMotionOn, false);
    surface.enterHome({ cwd: '/tmp' });
    assert.equal(surface.mouseOn, false);
  } finally { surface.close(); }
});
