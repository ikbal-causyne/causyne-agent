import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionPickerLayer, renderSessionRows } from '../src/tui/sessionPickerView.js';
import { stripAnsi, visibleWidth } from '../src/tui/text.js';

function fixtures(count = 40) {
  const recent = Date.now();
  const items = [
    { id: '__NEW_SESSION__', label: '+ New Session', category: 'Actions', description: 'start fresh', searchText: 'new session fresh', value: { type: 'new' } },
    { id: '__FORK_SESSION__', label: 'Fork Current', category: 'Actions', description: 'fork', searchText: 'fork branch', value: { type: 'fork' } }
  ];
  for (let i = 0; i < count; i++) {
    items.push({
      id: `s-${i}`,
      label: `Session ${i}${i === 0 ? ' [active]' : ''}`,
      category: i < 12 ? 'Today' : 'Yesterday',
      description: `${i + 2} msgs · ${i + 1}m ago · /work/${i % 2 ? 'other' : 'current'}`,
      searchText: `Session ${i} s-${i} /work/${i % 2 ? 'other' : 'current'}`,
      value: { type: 'switch', id: `s-${i}`, title: `Session ${i}`, workspace: `/work/${i % 2 ? 'other' : 'current'}`,
        messageCount: i + 2, updatedAt: recent - (i + 1) * 60000, isCurrent: i === 0 }
    });
  }
  return items;
}

function panel(count = 40) {
  return new SessionPickerLayer({ items: fixtures(count), currentWorkspace: '/work/current', activeId: 's-0', onPick() {} });
}

test('rows are compact, readable, and do not exceed panel columns', () => {
  const layer = panel(80);
  layer.list.moveTo(2, 15);
  for (const width of [30, 44, 68, 94]) {
    const rows = layer.body(width, 19);
    assert.equal(rows.length, 19);
    for (const line of rows) assert.ok(visibleWidth(line) <= width, `${width}: ${stripAnsi(line)}`);
    assert.ok(rows.some(row => stripAnsi(row).includes('Session 0')), 'active session must be visible');
    assert.ok(rows.some(row => stripAnsi(row).includes('ALL WORKSPACES')));
  }
});

test('selection is always visible through category boundaries and 860 sessions', () => {
  const layer = panel(860);
  layer.list.moveTo(700, 17);
  const rows = layer.body(84, 24).map(stripAnsi);
  assert.ok(rows.some(row => row.includes('Session 698')), 'selected session is not hidden by scrolling');
  assert.ok(rows.some(row => row.includes('Session 698') && row.includes('msgs')));
  assert.equal(layer.list.current.id, 's-698');
  assert.equal(layer.list.filtered.length, 862);
});

test('Tab scopes to the current workspace while retaining session actions', () => {
  const layer = panel(16);
  assert.equal(layer.scope, 'all');
  assert.equal(layer.key({ name: 'tab' }), 'handled');
  assert.equal(layer.scope, 'workspace');
  assert.equal(layer.list.all.filter(item => item.value.type === 'switch').length, 8);
  assert.equal(layer.list.all.length, 10);
  assert.equal(layer.list.all.some(item => item.id === 's-1'), false);
  assert.ok(layer.body(70, 19).some(row => stripAnsi(row).includes('THIS WORKSPACE')));
  layer.key({ name: 'tab' });
  assert.equal(layer.list.all.length, 18);
});

test('typing filters existing items without changing persisted session data', () => {
  const layer = panel(40);
  layer.list.query = 'Session 27';
  layer.list.refilter();
  const rows = layer.body(80, 18).map(stripAnsi).join('\n');
  assert.match(rows, /Session 27/);
  assert.match(rows, /1 \/ 40 sessions/);
  assert.equal(layer.list.all.length, 42);
});

test('narrow and short panels have no broken output', () => {
  const layer = panel(1);
  for (const height of [6, 9, 12]) {
    const rows = layer.body(28, height);
    assert.equal(rows.length, height);
    assert.ok(rows.every(line => visibleWidth(line) <= 28));
  }
});

test('window never leaves an orphaned category header', () => {
  const entries = fixtures(30).map(item => ({ item }));
  for (let start = 0; start < entries.length; start++) {
    const result = renderSessionRows(entries, start, start, 65, 5);
    assert.ok(result.rows.length <= 5);
    if (result.rows.length) assert.ok(!/^  (ACTIONS|TODAY|YESTERDAY)$/.test(stripAnsi(result.rows.at(-1))));
  }
});
