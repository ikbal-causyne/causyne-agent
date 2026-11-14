import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MessageActionsLayer, handleMessageActionMenuMouse } from '../src/tui/messageInteraction.js';

describe('messageInteraction finite bounds', () => {
  it('handleMessageActionMenuMouse ignores non-finite coordinates and floors fractional row indices', () => {
    const picked: unknown[] = [];
    const layer = new MessageActionsLayer(
      [
        { label: 'Copy', description: '', value: 'copy' },
        { label: 'Fork', description: '', value: 'fork' },
        { label: 'Revert', description: '', value: 'revert' }
      ],
      choice => picked.push(choice)
    );
    layer.actionLayout = { x: 10, y: 4, width: 40, count: 3 };

    const nanRes = handleMessageActionMenuMouse(layer, {
      mouse: { x: 15, y: Number.NaN, button: 0, pressed: true }
    });
    assert.equal(nanRes, 'handled');
    assert.equal(layer.list.selected, 0);
    assert.deepEqual(picked, []);

    const fracHover = handleMessageActionMenuMouse(layer, {
      mouse: { x: 15.8, y: 6.9 },
      sequence: '\x1b[<35;16;7M'
    });
    assert.equal(fracHover, 'handled');
    assert.equal(layer.list.selected, 1);
  });

  it('MessageActionsLayer.list.moveTo ignores non-finite indices and floors fractional indices', () => {
    const layer = new MessageActionsLayer(
      [
        { label: 'Copy', description: '', value: 'copy' },
        { label: 'Fork', description: '', value: 'fork' }
      ],
      () => {}
    );

    layer.list.moveTo(1);
    assert.equal(layer.list.selected, 1);

    layer.list.moveTo(Number.NaN);
    assert.equal(layer.list.selected, 1);

    layer.list.moveTo(0.9);
    assert.equal(layer.list.selected, 0);
  });

  it('MessageActionsLayer.preferredWidth and body guard non-finite widths cleanly', () => {
    const layer = new MessageActionsLayer(
      [{ label: 'Copy message', description: 'to clipboard', value: 'copy' }],
      () => {}
    );

    const w = layer.preferredWidth(Number.NaN);
    assert.equal(Number.isFinite(w), true);
    assert.ok(w >= 36);

    const rows = layer.body(Number.NaN);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].includes('Copy'));
  });
});
