import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  recordObservation, recordActuation, readSession, describeSession,
  clearSession, pruneSessions, getSessionDir, isSessionTrackingEnabled
} from '../src/embodimentSession.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_LOOP = fs.readFileSync(path.join(HERE, '..', 'src', 'agentLoop.js'), 'utf8');

const TASK = 'test-embodiment-session';
const cleanup = () => clearSession(TASK);

test('embodiment session: an observation records the app and survives a restart', () => {
  cleanup();
  recordObservation(TASK, 'Notes', 'AXButton: Export\nAXTextField: Title');

  // A fresh read is exactly what a restarted daemon does — nothing is cached
  // in memory between the write and this read.
  const state = readSession(TASK);
  assert.equal(state.app, 'Notes');
  assert.equal(state.lastTreeNodeCount, 2);
  assert.ok(state.observedAt, 'no observation timestamp');
  cleanup();
});

test('embodiment session: the screen contents are HASHED, never stored', () => {
  // A record of what a user's screen said, sitting in a file, is a
  // surveillance artefact. Only enough is kept to answer "is the screen still
  // as I left it?".
  cleanup();
  const secret = 'AXTextField: password = hunter2';
  recordObservation(TASK, 'Notes', secret);

  const raw = fs.readFileSync(path.join(getSessionDir(), `${TASK}.json`), 'utf8');
  assert.ok(!raw.includes('hunter2'), 'the screen contents were written to disk');
  assert.ok(!raw.includes('password'), 'the screen contents were written to disk');
  assert.ok(readSession(TASK).lastTreeDigest, 'nothing was recorded at all');
  cleanup();
});

test('embodiment session: an actuation records verbs but never their arguments', () => {
  cleanup();
  recordActuation(TASK, 'Notes', ['type', 'press']);

  const raw = fs.readFileSync(path.join(getSessionDir(), `${TASK}.json`), 'utf8');
  const state = readSession(TASK);
  assert.deepEqual(state.lastActions, ['type', 'press']);
  assert.ok(!raw.includes('hunter2'));
  cleanup();
});

test('embodiment session: acting invalidates the stored screen digest', () => {
  // The screen has almost certainly changed. Marking the digest stale beats
  // silently trusting it — a resumed agent that trusts a stale tree clicks a
  // button that has moved.
  cleanup();
  recordObservation(TASK, 'Notes', 'AXButton: Save');
  assert.ok(readSession(TASK).lastTreeDigest, 'the observation recorded no digest');

  recordActuation(TASK, 'Notes', ['press']);
  assert.equal(readSession(TASK).lastTreeDigest, null, 'the digest survived an actuation');
  cleanup();
});

test('embodiment session: the resume briefing tells the agent it does NOT know the outcome', () => {
  cleanup();
  recordActuation(TASK, 'Notes', ['type']);

  const briefing = describeSession(TASK);
  assert.match(briefing, /Notes/);
  assert.match(briefing, /do NOT know whether they landed/i, 'the briefing overstates what is known');
  assert.match(briefing, /ax_snapshot/, 'the briefing must send the agent to re-read before acting');
  cleanup();
});

test('embodiment session: no session means no briefing, not an empty header', () => {
  cleanup();
  assert.equal(describeSession(TASK), '', 'an absent session still injected tokens');
  assert.equal(describeSession('never-existed-at-all'), '');
});

test('embodiment session: fail-open — a corrupt file degrades to no session', () => {
  // Losing session state must degrade the agent to "re-read the screen", never
  // break the task. Same contract outputStore.js holds.
  cleanup();
  recordObservation(TASK, 'Notes', 'AXButton: Save');
  fs.writeFileSync(path.join(getSessionDir(), `${TASK}.json`), '{ not json at all');

  assert.equal(readSession(TASK), null, 'a corrupt session threw instead of degrading');
  assert.equal(describeSession(TASK), '');
  cleanup();
});

test('embodiment session: an untrusted task id cannot escape the session directory', () => {
  // taskId arrives from the phone, so it is untrusted input on a path join.
  const hostile = '../../../../etc/passwd';
  recordObservation(hostile, 'Notes', 'AXButton: Save');

  const escaped = path.join(getSessionDir(), '..', '..', '..', '..', 'etc', 'passwd.json');
  assert.ok(!fs.existsSync(escaped), 'a hostile task id wrote outside the session directory');
  clearSession(hostile);
});

test('embodiment session: the kill switch is honoured', () => {
  cleanup();
  const previous = process.env.CAUSYNE_EMBODIMENT_SESSION;
  process.env.CAUSYNE_EMBODIMENT_SESSION = '0';
  try {
    assert.equal(isSessionTrackingEnabled(), false);
    recordObservation(TASK, 'Notes', 'AXButton: Save');
    assert.equal(readSession(TASK), null, 'state was recorded with tracking disabled');
  } finally {
    if (previous === undefined) delete process.env.CAUSYNE_EMBODIMENT_SESSION;
    else process.env.CAUSYNE_EMBODIMENT_SESSION = previous;
  }
  cleanup();
});

test('embodiment session: pruning never throws, even with nothing to prune', () => {
  assert.doesNotThrow(() => pruneSessions());
});

test('agent loop: the briefing sits in the VOLATILE block, not a cached anchor', () => {
  // Session state changes as the task runs. Putting it in a cache-anchored
  // system block would invalidate the whole cached prefix every time the agent
  // touched a screen — undoing Part I to deliver Part II.
  const volatileBlock = AGENT_LOOP.slice(AGENT_LOOP.indexOf('CURRENT AUTONOMY MODE'));
  assert.ok(
    AGENT_LOOP.includes('${describeSession(this.taskId)}CURRENT AUTONOMY MODE'),
    'the resume briefing is no longer attached to the volatile tail'
  );
  assert.ok(
    !volatileBlock.slice(0, 400).includes('cacheAnchor: true'),
    'the block carrying the briefing became a cache anchor'
  );
});
