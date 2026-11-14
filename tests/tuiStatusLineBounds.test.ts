import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { StatusLine, compactCount, formatCost, formatElapsed } from '../src/tui/statusLine.js';
import { stripAnsi, visibleWidth } from '../src/tui/text.js';

describe('StatusLine bounds and sanitization', () => {
  test('compactCount avoids rounding boundary rollover like 1000 for 999.6 or 1000k for 999600', () => {
    assert.equal(compactCount(999.6), '1.0k');
    assert.equal(compactCount(9999.6), '10k');
    assert.equal(compactCount(999600), '1.0M');
    assert.equal(compactCount(-10), '0');
    assert.equal(compactCount(Number.NaN), '0');
  });

  test('StatusLine collapses embedded newlines and strips unsafe sequences across renderIdle, render, and renderStatic', () => {
    const status = new StatusLine();
    status.setSession({
      model: 'openai/gpt-5\ninjected\x1b[2J-model-name-very-long',
      cwd: '/tmp/dir\nwith-newline\x1b[2J',
      contextChars: 4000,
      contextLimit: 16000
    });

    const idle = status.renderIdle({ width: 80, hint: 'ctrl+p\npalette\x1b[2J' });
    assert.ok(!idle.includes('\n') && !idle.includes('\r'), 'renderIdle must be single-line');
    assert.ok(!idle.includes('\x1b[2J'), 'renderIdle must strip unsafe CSI');
    assert.ok(visibleWidth(idle) <= 79);

    const active = status.render({
      message: 'Running\nmultiline\x1b[2J step',
      elapsedMs: 1200,
      steps: 2,
      width: 80
    });
    assert.ok(!active.includes('\n') && !active.includes('\r'), 'render must be single-line');
    assert.ok(!active.includes('\x1b[2J'), 'render must strip unsafe CSI');
    assert.ok(visibleWidth(active) <= 79);

    const stat = status.renderStatic('Completed\ntask\x1b[2J', 60);
    assert.ok(!stat.includes('\n') && !stat.includes('\r'), 'renderStatic must be single-line');
    assert.ok(!stat.includes('\x1b[2J'), 'renderStatic must strip unsafe CSI');
    assert.ok(visibleWidth(stat) <= 60);
  });

  test('StatusLine respects narrow widths (< 10 columns) without overflowing safeWidth - 1', () => {
    const status = new StatusLine();
    status.setSession({ cwd: '/Users/example/project', model: 'claude-sonnet' });

    const idleNarrow = status.renderIdle({ width: 8, hint: 'ctrl+p' });
    assert.ok(visibleWidth(idleNarrow) <= 7, `idleNarrow width ${visibleWidth(idleNarrow)} must be <= 7`);

    const activeNarrow = status.render({ message: 'working hard', spinnerFrame: '⠋', width: 8 });
    assert.ok(visibleWidth(activeNarrow) <= 7, `activeNarrow width ${visibleWidth(activeNarrow)} must be <= 7`);
  });
});
