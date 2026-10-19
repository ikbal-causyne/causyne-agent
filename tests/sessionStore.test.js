import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  createSession, listSessions, resolveSession, switchSession, deleteSession,
  saveSessionMessages, getActiveSessionId, pruneSessions, titleFrom,
  SESSION_DIR, RESUME_WINDOW_MS
} from '../src/sessionStore.js';
import { MemoryManager } from '../src/memoryManager.js';

// Sessions created by these tests, cleaned up at the end.
const created = [];
const workspace = (name) => `/tmp/causyne-test-${name}-${process.pid}`;
const track = (session) => { created.push(session.id); return session; };

test.after(() => {
  for (const id of created) { try { deleteSession(id); } catch (e) { /* already gone */ } }
});

test('sessions: a different workspace is a different conversation', () => {
  // THE BOOMERANG. One global chat_history.json was read by every invocation in
  // every directory, so typing "continue" in a new project resumed a
  // conversation from a different one — months old — and sent the agent
  // scanning work that had nothing to do with the task at hand.
  const a = track(createSession(workspace('a'), 'blender pen'));
  saveSessionMessages(a.id, [{ role: 'user', content: 'build the pen' }]);

  const b = track(resolveSession(workspace('b')));

  assert.notEqual(b.id, a.id, 'a second workspace resumed the first workspace conversation');
  assert.equal(b.messages.length, 0, 'messages bled across workspaces');
});

test('sessions: the same workspace resumes, while it is recent', () => {
  const dir = workspace('resume');
  const first = track(resolveSession(dir));
  saveSessionMessages(first.id, [{ role: 'user', content: 'keep going' }]);

  const again = resolveSession(dir);
  assert.equal(again.id, first.id, 'a recent conversation in the same directory should resume');
  assert.equal(again.messages.length, 1);
});

test('sessions: a stale conversation does NOT silently resume', () => {
  // The other half of the boomerang: coming back to a directory weeks later and
  // having a forgotten conversation become the thing "continue" continues.
  const dir = workspace('stale');
  const old = track(createSession(dir, 'ancient work'));
  saveSessionMessages(old.id, [{ role: 'user', content: 'something from long ago' }]);

  // Age it past the resume window.
  const file = path.join(SESSION_DIR, `${old.id}.json`);
  const aged = JSON.parse(fs.readFileSync(file, 'utf8'));
  aged.updatedAt = Date.now() - RESUME_WINDOW_MS - 60_000;
  fs.writeFileSync(file, JSON.stringify(aged));

  const fresh = track(resolveSession(dir));
  assert.notEqual(fresh.id, old.id, 'a stale conversation was silently resumed');
  assert.equal(fresh.messages.length, 0);

  // But it is not lost — it is still listed and switchable by name.
  assert.ok(listSessions().some((s) => s.id === old.id), 'the old conversation was destroyed rather than parked');
  assert.equal(switchSession(old.id).messages.length, 1, 'the old conversation could not be resumed on purpose');
});

test('sessions: switching changes what is active', () => {
  const one = track(createSession(workspace('sw1'), 'one'));
  const two = track(createSession(workspace('sw2'), 'two'));

  assert.equal(getActiveSessionId(), two.id);
  switchSession(one.id);
  assert.equal(getActiveSessionId(), one.id);
});

test('sessions: a title comes from the first thing the user asked', () => {
  const s = track(createSession(workspace('title')));
  saveSessionMessages(s.id, [{ role: 'user', content: 'buat pena 3d di blender jadi klip 8 detik' }]);

  const listed = listSessions().find((row) => row.id === s.id);
  assert.match(listed.title, /pena 3d/, 'a session you cannot name is a session you cannot leave');

  assert.equal(titleFrom(''), 'Untitled');
  assert.ok(titleFrom('x'.repeat(200)).length <= 60, 'a title must stay listable');
});

test('sessions: the count is capped, oldest first', () => {
  const before = listSessions().length;
  for (let i = 0; i < 3; i++) track(createSession(workspace(`cap${i}`), `cap ${i}`));

  const removed = pruneSessions(before); // prune back to where we started
  assert.ok(removed >= 3, `expected the oldest to be retired, removed ${removed}`);
  assert.ok(listSessions().length <= before, 'the ceiling did not hold');
});

test('sessions: corrupt files degrade to no session, never to a crash', () => {
  const s = track(createSession(workspace('corrupt'), 'broken'));
  fs.writeFileSync(path.join(SESSION_DIR, `${s.id}.json`), '{ not json');

  assert.doesNotThrow(() => listSessions());
  assert.equal(switchSession(s.id), null);
});

test('memory: clearing one conversation leaves every other one alone', () => {
  const a = new MemoryManager(workspace('clear-a'));
  const b = new MemoryManager(workspace('clear-b'));
  created.push(a.sessionId, b.sessionId);

  a.saveHistory([{ role: 'user', content: 'A' }]);
  b.saveHistory([{ role: 'user', content: 'B' }]);

  a.clearHistory();

  assert.equal(a.loadHistory().length, 0, '/clear did not clear its own conversation');
  assert.equal(new MemoryManager(workspace('clear-b')).loadHistory().length, 1,
    '/clear wiped a conversation belonging to a different workspace');
});

test('memory: history is per session, not one global file', () => {
  const source = fs.readFileSync(new URL('../src/memoryManager.js', import.meta.url), 'utf8');
  assert.match(source, /saveSessionMessages/, 'history is being written somewhere other than the session store');
  assert.ok(
    !/writeFileSync\(\s*CHAT_HISTORY_FILE/.test(source),
    'the single global chat_history.json is back — that file WAS the bug'
  );
});
