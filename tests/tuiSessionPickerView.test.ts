import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SessionPickerLayer, renderSessionRows } from '../src/tui/sessionPickerView.js';
import { stripAnsi } from '../src/tui/text.js';

const sampleItem = () => ({
  id: 's-1',
  label: 'Test Session',
  category: 'Today',
  description: '2 msgs',
  searchText: 'Test Session',
  value: {
    type: 'switch' as const,
    id: 's-1',
    title: 'Test Session',
    workspace: '/tmp/ws',
    messageCount: 2,
    updatedAt: Date.now()
  }
});

describe('sessionPickerView bounds', () => {
  it('renderSessionRows clamps negative start and non-finite width without throwing', () => {
    const entries = [{ item: sampleItem() }];
    assert.doesNotThrow(() => {
      const neg = renderSessionRows(entries, -2, 0, 60, 5);
      assert.equal(neg.lastIndex, 0);
      assert.ok(neg.rows.length >= 1);

      const infWidth = renderSessionRows(entries, 0, 0, Number.POSITIVE_INFINITY, 5);
      assert.ok(infWidth.rows.length >= 1);
    });
  });

  it('SessionPickerLayer.body handles non-finite dimensions and preserves surrogate pairs in visibleQuery', () => {
    const layer = new SessionPickerLayer({
      items: [sampleItem()],
      currentWorkspace: '/tmp/ws',
      activeId: 's-1',
      onPick() {}
    });

    assert.doesNotThrow(() => {
      const rows = layer.body(Number.POSITIVE_INFINITY, Number.NaN);
      assert.ok(rows.length >= 3);
      assert.ok(Number.isFinite((layer as { cursor?: { x: number } }).cursor?.x));
    });

    // Odd maxInput width would split a 2-col emoji ('🚀') under UTF-16 .slice(1)
    layer.list.query = '🚀'.repeat(8) + 'a';
    const narrowRows = layer.body(14, 10);
    const inputRow = narrowRows[1] ?? '';
    assert.equal(Buffer.from(inputRow, 'utf8').toString('utf8'), inputRow);
  });

  it('omits dangling separator for non-finite updatedAt/messageCount and sanitizes NaN selected/offset', () => {
    const badItem = {
      ...sampleItem(),
      value: {
        ...sampleItem().value,
        messageCount: Number.NaN,
        updatedAt: Number.NaN,
        isCurrent: true
      }
    };
    const rendered = renderSessionRows([{ item: badItem }], 0, 0, 80, 5);
    const plain = rendered.rows.map(stripAnsi).join('\n');
    assert.doesNotMatch(plain, /\bNaN\b/);
    assert.match(plain, /0 msgs\s+ACTIVE/);

    const layer = new SessionPickerLayer({
      items: [sampleItem()],
      currentWorkspace: '/tmp/ws',
      activeId: 's-1',
      onPick() {}
    });
    layer.list.selected = Number.NaN;
    layer.list.offset = Number.NaN;
    layer.body(80, 18);
    assert.equal(Number.isFinite(layer.list.offset), true);
  });
});
