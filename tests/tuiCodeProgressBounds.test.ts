import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { codeProgressFromAction, renderCodeProgress } from '../src/tui/codeProgress.js';
import { visibleWidth } from '../src/tui/text.js';

describe('codeProgress finite bounds', () => {
  it('renderCodeProgress clamps non-finite and sub-12 widths without RangeError', () => {
    const event = codeProgressFromAction('fs_write', {
      path: 'src/app.ts',
      content: 'export const ok = true;\n'
    });
    assert.ok(event);
    assert.doesNotThrow(() => {
      const infRows = renderCodeProgress(event, Number.POSITIVE_INFINITY);
      assert.equal(visibleWidth(infRows[0]!), 80);

      const nanRows = renderCodeProgress(event, Number.NaN);
      assert.equal(visibleWidth(nanRows[0]!), 80);

      const negRows = renderCodeProgress(event, Number.NEGATIVE_INFINITY);
      assert.equal(visibleWidth(negRows[0]!), 80);

      const tinyRows = renderCodeProgress(event, 0.5);
      assert.equal(visibleWidth(tinyRows[0]!), 12);
    });
  });
});
