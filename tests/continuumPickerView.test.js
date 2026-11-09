import test from 'node:test';
import assert from 'node:assert/strict';
import { ContinuumPickerLayer, renderContinuumWindow, sortContinuumItems }
  from '../src/continuum/ui/continuumPickerView.js';
import { stripAnsi, visibleWidth } from '../src/tui/text.js';

function fixture(count = 80) {
  const sources = [
    ['codex', 'Codex'], ['antigravity', 'Antigravity'],
    ['opencode', 'OpenCode'], ['claude_code', 'Claude Code'], ['causyne', 'Causyne']
  ];
  return Array.from({ length: count }, (_, i) => {
    const [sourcePlatform, sourceLabel] = sources[i % sources.length];
    const summary = {
      id: `${sourcePlatform}:session-${i}`,
      sourcePlatform,
      sourceLabel,
      title: i === 7 ? 'Design a multilingual dashboard in Vue with advanced filtering' :
        `Build task ${i} with a long descriptive engineering title`,
      workspacePath: i % 3 ? `/Users/dev/Causyne/projects/project-${i}` : 'C:\\Development\\Causyne\\Project',
      snippet: `Original intent ${i}: build an agent with accurate context and a clear result.`,
      updatedAt: Date.now() - i * 60000,
      messageCount: i === 0 ? 1960 : i + 1
    };
    return {
      label: summary.title, category: sourceLabel,
      searchText: `${summary.id} ${summary.sourceLabel} ${summary.title} ${summary.workspacePath} ${summary.snippet}`,
      description: `${summary.messageCount} msgs`, value: summary
    };
  });
}

function picker(count = 80, options = {}) {
  return new ContinuumPickerLayer({ sessions: fixture(count), onPick() {}, ...options });
}

// These tests exercise the same source TypeScript compiled to JavaScript by npm run build.
test('dialog uses wider hierarchy without terminal wrapping at common widths', () => {
  const layer = picker();
  for (const width of [28, 42, 68, 100, 108]) {
    for (const height of [9, 12, 20, 28]) {
      const rows = layer.body(width, height);
      assert.equal(rows.length, height);
      for (const row of rows) {
        assert.ok(visibleWidth(row) <= width, `${width}: ${stripAnsi(row)}`);
        assert.ok(!stripAnsi(row).includes('\n'));
      }
    }
  }
});

test('selected entry remains visible when navigating 80 cross-agent sessions', () => {
  const layer = picker();
  layer.list.moveTo(72, 8);
  const id = layer.list.current?.value.id;
  const title = layer.list.current?.value.title;
  const rendered = layer.body(92, 25).map(stripAnsi).join('\n');
  assert.equal(layer.list.current.value.id, id);
  assert.ok(rendered.includes(title), `selected title not visible: ${id}`);
  assert.equal(layer.list.filtered.length, 80);
});

test('Tab and Shift+Tab change source scope and retain the typed search', () => {
  const layer = picker(40);
  assert.equal(layer.scope, 'all');
  layer.list.query = 'Build';
  layer.list.refilter();
  layer.key({ name: 'tab' });
  assert.equal(layer.scope, 'codex');
  assert.equal(layer.list.query, 'Build');
  assert.ok(layer.list.filtered.every(e => e.item.value.sourcePlatform === 'codex'));
  layer.key({ name: 'tab', shift: true });
  assert.equal(layer.scope, 'all');
  assert.equal(layer.list.query, 'Build');
});

test('F2 previews exactly the selected session without adopting it', () => {
  const previewed = []; const selected = [];
  const layer = picker(12, {
    onPreview: session => previewed.push(session.id),
    onPick: item => selected.push(item?.value.id)
  });
  const currentId = layer.list.current.value.id;
  assert.equal(layer.key({ name: 'f2' }), 'handled');
  assert.deepEqual(previewed, [currentId]);
  assert.deepEqual(selected, []);
  assert.equal(layer.key({ name: 'enter' }), 'close');
  assert.deepEqual(selected, [currentId]);
});

test('empty matches render a useful state, without modifying the source list', () => {
  const layer = picker(14);
  layer.list.query = 'unlikely-search-term-123-xyz';
  layer.list.refilter();
  const before = layer.list.all.length;
  const rendered = layer.body(78, 20).map(stripAnsi).join('\n');
  assert.match(rendered, /No sessions match/);
  assert.equal(layer.list.all.length, before);
});

test('provider groups sort stably and sanitized source rows respect width', () => {
  const entries = sortContinuumItems(fixture(30)).map(item => ({ item }));
  const platforms = entries.map(entry => entry.item.value.sourcePlatform);
  assert.equal(platforms[0], 'codex');
  assert.equal(platforms.at(-1), 'causyne');
  for (const budget of [2, 3, 5, 10, 13]) {
    for (let start = 0; start < entries.length; start++) {
      const window = renderContinuumWindow(entries, start, start, 54, budget);
      assert.ok(window.rows.length <= budget);
      assert.ok(window.rows.every(row => visibleWidth(row) <= 54));
      assert.ok(window.rows.length === 0 || !/^(\s*)(CODEX|ANTIGRAVITY|OPENCODE|CLAUDE CODE|CAUSYNE)$/.test(stripAnsi(window.rows.at(-1))));
    }
  }
});

test('Paste, backspace, and keyboard navigation preserve selection semantics', () => {
  const layer = picker(30);
  const old = layer.list.current.value.id;
  layer.key({ name: 'down' });
  assert.notEqual(layer.list.current.value.id, old);
  layer.key({ name: 'home' });
  assert.equal(layer.list.selected, 0);
  layer.key({ name: 'end' });
  assert.equal(layer.list.selected, 29);
  layer.key({ name: 'pageup' });
  assert.ok(layer.list.selected < 29);
  layer.key({ name: 'paste', text: 'nonexistentxyz' });
  assert.equal(layer.list.filtered.length, 0);
  layer.key({ name: 'backspace' });
  assert.ok(layer.list.query.length > 0);
});
