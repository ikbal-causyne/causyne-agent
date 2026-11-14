import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionSidebarRows, joinSessionSidebar, SIDEBAR_WIDTH } from '../src/tui/sessionSidebar.js';
import { stripAnsi, visibleWidth } from '../src/tui/text.js';

test('sessionSidebarRows collapses embedded newlines in title, skill description, and plan steps and guards non-finite height', () => {
  const rows = sessionSidebarRows({
    title: 'First line\nSecond line',
    provider: 'acp/opencode',
    model: 'deepseek\nflash',
    cwd: '/tmp/work\ndir',
    activeSkill: {
      id: 'domain/skill\nid',
      description: 'Multi-line\nskill description\nfrom frontmatter'
    },
    plan: [
      { text: 'Step one\nwith newline', status: 'in_progress' }
    ]
  }, 30);

  assert.equal(rows.length, 30);
  for (let i = 0; i < rows.length; i++) {
    assert.ok(!rows[i]!.includes('\n') && !rows[i]!.includes('\r'), `Row ${i} must not contain raw newline`);
    assert.equal(visibleWidth(rows[i]!), SIDEBAR_WIDTH, `Row ${i} must be exactly ${SIDEBAR_WIDTH} columns`);
  }
  const plain = stripAnsi(rows.join('\n'));
  assert.match(plain, /First line Second line/);
  assert.match(plain, /Step one with newline/);

  const infRows = sessionSidebarRows({
    title: 'Test',
    provider: 'prov',
    model: 'mod'
  }, Number.POSITIVE_INFINITY);
  assert.equal(infRows.length, 1);
});

test('joinSessionSidebar normalizes sideRows width and strips embedded newlines', () => {
  const joined = joinSessionSidebar(['hello\nworld'], ['side\nrow'], 20);
  assert.equal(joined.length, 1);
  assert.ok(!joined[0]!.includes('\n'));
  assert.equal(visibleWidth(joined[0]!), 20 + SIDEBAR_WIDTH);
});

test('sessionSidebarRows filters malformed plan entries and preserves the active step on compact heights', () => {
  const plan: any[] = [
    null,
    { text: 'Step 1', status: 'completed' },
    undefined,
    { text: 'Step 2', status: 'in_progress' },
    { text: 'Step 3', status: 'pending' }
  ];
  const rows = sessionSidebarRows({ title: 'Compact', plan }, 5);
  assert.equal(rows.length, 5);
  const plain = stripAnsi(rows.join('\n'));
  assert.match(plain, /Plan  1\/3/);
  assert.match(plain, /▸ Step 2/);
});

