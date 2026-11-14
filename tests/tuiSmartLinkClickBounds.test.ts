import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectLinkAtPoint,
  type SmartLinkSurface
} from '../src/tui/smartLinkClick.js';
import type { MessageMarker } from '../src/tui/messageInteraction.js';

describe('smartLinkClick finite and integer bounds', () => {
  it('detectLinkAtPoint floors fractional coordinates and handles non-finite scrollTop and out.rows', () => {
    const rowWithLink = '  Live: https://example.com/demo ready';
    const marker: MessageMarker = {
      id: 1,
      kind: 'assistant',
      row: 0,
      meta: { messageText: rowWithLink }
    };
    const makeSurface = (scrollTop: number, outRows: number): SmartLinkSurface => ({
      width: 100,
      out: { rows: outRows },
      stage: { height: 10, reserved: true },
      viewport: { height: 5, width: 97, scrollTop },
      transcript: { flatten: () => ({ rows: [rowWithLink], markers: [marker] }) }
    });

    const fractionalHit = detectLinkAtPoint(makeSurface(0, 20), { x: 15.8, y: 14.7 }, marker);
    assert.equal(fractionalHit?.url, 'https://example.com/demo');

    const nanScrollHit = detectLinkAtPoint(makeSurface(Number.NaN, 20), { x: 15, y: 14 }, marker);
    assert.equal(nanScrollHit?.url, 'https://example.com/demo');

    const infOutRowsHit = detectLinkAtPoint(
      makeSurface(0, Number.POSITIVE_INFINITY),
      { x: 15, y: 4 },
      marker
    );
    assert.equal(infOutRowsHit?.url, 'https://example.com/demo');
  });
});
