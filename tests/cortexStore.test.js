import test from 'node:test';
import assert from 'node:assert/strict';

import { cortexDb } from '../src/cortex/vectorDb.js';

// These exercise the REAL store, so everything they write is scoped to a
// throwaway workspace and removed afterwards.
const WS_A = `/tmp/cortex-test-a-${process.pid}`;
const WS_B = `/tmp/cortex-test-b-${process.pid}`;

let available = true;

test.before(async () => {
  try { await cortexDb.init(); } catch (e) { available = false; }
});

test.after(async () => {
  if (!available) return;
  await cortexDb.forget({ workspace: WS_A });
  await cortexDb.forget({ workspace: WS_B });
});

test('cortex: the schema carries workspace, kind, fingerprint and hits', async (t) => {
  if (!available) return t.skip('neural engine not provisioned');
  await cortexDb.ensureDb();
  const columns = new Set(cortexDb.db.prepare('PRAGMA table_info(task_memories)').all().map(c => c.name));
  for (const column of ['workspace', 'kind', 'fingerprint', 'hits']) {
    assert.ok(columns.has(column), `the store lost its "${column}" column`);
  }
});

test('cortex: the same lesson twice is reinforced, not duplicated', async (t) => {
  if (!available) return t.skip('neural engine not provisioned');
  // A real store held 11 rows carrying 3 distinct lessons. Duplicates do not
  // merely waste space — they crowd each other out of a top-3, so the agent
  // paid for three slots and received one lesson.
  await cortexDb.forget({ workspace: WS_A });

  const first = await cortexDb.saveMemory('build the pen', 'EEVEE_NEXT missing', 'use BLENDER_EEVEE', WS_A);
  const second = await cortexDb.saveMemory('build the pen', 'EEVEE_NEXT missing', 'use BLENDER_EEVEE', WS_A);

  assert.equal(first.created, true);
  assert.equal(second.created, false, 'an identical lesson created a second row');
  assert.equal(second.id, first.id, 'reinforcement should land on the same row');

  const rows = cortexDb.db.prepare('SELECT COUNT(*) c FROM task_memories WHERE workspace = ?').get(WS_A).c;
  assert.equal(rows, 1);
});

test('cortex: a lesson from one project never reaches another', async (t) => {
  if (!available) return t.skip('neural engine not provisioned');
  // The same class of bug as one global chat_history.json: a relevance problem
  // AND a confidentiality problem. A lesson about one client's repository must
  // not be injected into another client's task.
  await cortexDb.forget({ workspace: WS_A });
  await cortexDb.forget({ workspace: WS_B });

  await cortexDb.saveMemory(
    'compile the android release build',
    'gradle daemon ran out of heap',
    'raise org.gradle.jvmargs to 4g',
    WS_A
  );

  const fromB = await cortexDb.search('gradle daemon heap error on release build', 5, { workspace: WS_B });
  assert.ok(!fromB.some((m) => /jvmargs/.test(m.text)), 'a lesson leaked into a different project');

  const fromA = await cortexDb.search('gradle daemon heap error on release build', 5, { workspace: WS_A });
  assert.ok(fromA.some((m) => /jvmargs/.test(m.text)), 'a project could not retrieve its own lesson');
});

test('cortex: global memories still reach every project', async (t) => {
  if (!available) return t.skip('neural engine not provisioned');
  // Scoping must NARROW, never hide what was always shared. Everything recorded
  // before scoping existed carries workspace '' and has to keep working.
  await cortexDb.forget({ workspace: WS_B });
  await cortexDb.upsertMemory(
    'CREATIVE SUCCESS: Built "atlas" using brutalist style. Colors: ink and amber. Fonts: mono.',
    { workspace: '', kind: 'creative' }
  );

  const seen = await cortexDb.search('brutalist design with a mono typeface', 5, { workspace: WS_B });
  assert.ok(seen.some((m) => /brutalist/i.test(m.text)), 'a global memory stopped reaching a project');

  await cortexDb.db.prepare("DELETE FROM task_memories WHERE text LIKE '%atlas%' AND workspace = ''").run();
});

test('cortex: an older memory is ranked below a newer one of equal similarity', async (t) => {
  if (!available) return t.skip('neural engine not provisioned');
  // `timestamp` was stored and never read: a lesson from March outranked one
  // from last week, and March's codebase does not exist any more.
  await cortexDb.forget({ workspace: WS_A });

  const recent = await cortexDb.upsertMemory('the vite dev server needs --host to be reachable', { workspace: WS_A });
  const old = await cortexDb.upsertMemory('the vite dev server needs --host to be visible', { workspace: WS_A });

  // Age the second one by a year.
  cortexDb.db.prepare('UPDATE task_memories SET timestamp = ? WHERE id = ?')
    .run(Date.now() - 365 * 24 * 60 * 60 * 1000, old.id);

  const results = await cortexDb.search('vite dev server host flag', 5, { workspace: WS_A });
  const recentHit = results.find((m) => m.id === recent.id);
  const oldHit = results.find((m) => m.id === old.id);

  if (recentHit && oldHit) {
    assert.ok(recentHit.score > oldHit.score, 'recency decay is not being applied');
    assert.ok(oldHit.similarity > 0, 'the old memory should still be similar, just outranked');
  }
});

test('cortex: retrieval records which memories actually earn their place', async (t) => {
  if (!available) return t.skip('neural engine not provisioned');
  await cortexDb.forget({ workspace: WS_A });
  const saved = await cortexDb.upsertMemory('the postgres migration must run before the seed script', { workspace: WS_A });

  const before = cortexDb.db.prepare('SELECT hits FROM task_memories WHERE id = ?').get(saved.id).hits;
  await cortexDb.search('run migrations before seeding postgres', 3, { workspace: WS_A });
  const after = cortexDb.db.prepare('SELECT hits FROM task_memories WHERE id = ?').get(saved.id).hits;

  assert.ok(after > before, 'a retrieved memory did not record the hit');
});

test('cortex: search is bounded, not a full table scan', async () => {
  // `SELECT *` loaded every row and JSON.parsed a 384-float vector for each, on
  // the hot path of every task start.
  const source = await import('node:fs').then(fs =>
    fs.readFileSync(new URL('../src/cortex/vectorDb.js', import.meta.url), 'utf8'));

  assert.ok(!/SELECT \* FROM task_memories/.test(source), 'the unbounded scan is back');
  assert.match(source, /LIMIT \?/, 'candidates are no longer capped');
  assert.match(source, /idx_memories_ws_time/, 'the workspace index is gone');
});

test('cortex: creative patterns are found by column, not by a LIKE on prose', async (t) => {
  if (!available) return t.skip('neural engine not provisioned');
  // Strip comments first. The file EXPLAINS the old bug by quoting it, and a
  // raw scan would fail on its own documentation — the same trap ZM-09 tests
  // keep falling into.
  const raw = await import('node:fs').then(fs =>
    fs.readFileSync(new URL('../src/cortex/vectorDb.js', import.meta.url), 'utf8'));
  const source = raw.split('\n')
    .filter((line) => {
      const s = line.trim();
      return !s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*');
    })
    .join('\n');

  assert.ok(
    !/LIKE 'CREATIVE SUCCESS/.test(source),
    'type is being inferred from a text prefix again — a full scan against a convention nothing enforces'
  );
  assert.match(source, /WHERE kind = \?/, 'the kind column is no longer used for lookup');
});

test('cortex: forgetting one project leaves the others intact', async (t) => {
  if (!available) return t.skip('neural engine not provisioned');
  await cortexDb.forget({ workspace: WS_A });
  await cortexDb.forget({ workspace: WS_B });

  await cortexDb.upsertMemory('lesson belonging to A', { workspace: WS_A });
  await cortexDb.upsertMemory('lesson belonging to B', { workspace: WS_B });

  const removed = await cortexDb.forget({ workspace: WS_A });
  assert.equal(removed, 1);
  assert.equal(cortexDb.db.prepare('SELECT COUNT(*) c FROM task_memories WHERE workspace = ?').get(WS_B).c, 1);
});

test('cortex: /cortex reports honestly rather than looking empty when broken', async () => {
  // A silent Cortex is indistinguishable from an empty one, and the user is
  // entitled to know which they have.
  const { listCommands } = await import('../src/commands.js');
  const command = listCommands().find((c) => c.name === 'cortex');

  assert.ok(command, '/cortex is not registered — a memory you cannot read is a black box');
  const result = await command.run([]);
  assert.ok(typeof result.output === 'string' && result.output.length > 0);
});
