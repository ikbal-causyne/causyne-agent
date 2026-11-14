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
});
