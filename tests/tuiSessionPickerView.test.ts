import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderSessionRows } from '../src/tui/sessionPickerView.js';

describe('sessionPickerView bounds', () => {
  it('renderSessionRows clamps negative start and non-finite width without throwing', () => {
    const entries = [{
      item: {
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
      }
    }];
    assert.doesNotThrow(() => {
      const neg = renderSessionRows(entries, -2, 0, 60, 5);
      assert.equal(neg.lastIndex, 0);
      assert.ok(neg.rows.length >= 1);

      const infWidth = renderSessionRows(entries, 0, 0, Number.POSITIVE_INFINITY, 5);
      assert.ok(infWidth.rows.length >= 1);
    });
  });
});
