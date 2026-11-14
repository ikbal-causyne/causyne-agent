import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionPickerItems } from '../src/tui/sessionPicker.js';

describe('sessionPicker finite timestamps', () => {
  it('formatTimeAgo via buildSessionPickerItems avoids NaNd ago for non-finite updatedAt', () => {
    const items = buildSessionPickerItems(
      [
        {
          id: 's-bad-ts',
          workspace: '/tmp/ws',
          workspaceKey: 'k',
          title: 'Corrupt Timestamp',
          createdAt: 0,
          updatedAt: Number.NaN,
          messageCount: 3
        }
      ],
      '',
      '/tmp/ws'
    );
    const entry = items.find((item) => item.id === 's-bad-ts');
    assert.ok(entry);
    assert.doesNotMatch(entry.description, /\bNaN/);
  });
});
