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

  it('buildSessionPickerItems sorts valid sessions newest-first even when NaN updatedAt is present', () => {
    const items = buildSessionPickerItems(
      [
        {
          id: 's-oldest',
          workspace: '/tmp/ws',
          workspaceKey: 'k',
          title: 'Oldest',
          createdAt: 0,
          updatedAt: 1000,
          messageCount: 2
        },
        {
          id: 's-corrupt',
          workspace: '/tmp/ws',
          workspaceKey: 'k',
          title: 'Corrupt',
          createdAt: 0,
          updatedAt: Number.NaN,
          messageCount: 2
        },
        {
          id: 's-newest',
          workspace: '/tmp/ws',
          workspaceKey: 'k',
          title: 'Newest',
          createdAt: 0,
          updatedAt: 2000,
          messageCount: 2
        }
      ],
      '',
      '/tmp/ws'
    );
    const orderedIds = items.filter((item) => item.id.startsWith('s-')).map((item) => item.id);
    assert.deepEqual(orderedIds, ['s-newest', 's-oldest', 's-corrupt']);
  });
});
