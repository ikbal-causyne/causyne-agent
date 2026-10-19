import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { causyneHome } from '../src/utils/paths.js';

function sourceWithoutComments(file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => {
      const s = line.trim();
      return !s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*');
    })
    .join('\n');
}

function allSourceFiles(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) allSourceFiles(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('state: nothing hardcodes the state root any more', () => {
  // Twenty-six call sites each wrote path.join(os.homedir(), '.causyne', …), so
  // the store location was not a decision anything could make. `npm test` wrote
  // into the developer's OWN agent state: 290 checkpoint tasks named
  // "test-task" and 28 MB of workspace tree objects, in the same undo history
  // the user's real work lives in.
  const src = fileURLToPath(new URL('../src', import.meta.url));
  const offenders = [];

  for (const file of allSourceFiles(src)) {
    if (file.endsWith(path.join('utils', 'paths.js'))) continue; // where the default lives
    if (/homedir\(\)\s*,\s*'\.causyne'/.test(sourceWithoutComments(file))) {
      offenders.push(path.relative(src, file));
    }
  }

  assert.deepEqual(offenders, [], 'these modules bypass causyneHome() and cannot be isolated');
});

test('state: CAUSYNE_HOME actually moves every store', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-root-'));
  const script = `
    import { causyneHome } from '${new URL('../src/utils/paths.js', import.meta.url).pathname}';
    const mods = await Promise.all([
      import('${new URL('../src/tokenTracker.js', import.meta.url).pathname}'),
      import('${new URL('../src/sessionStore.js', import.meta.url).pathname}'),
      import('${new URL('../src/checkpoints.js', import.meta.url).pathname}')
    ]);
    process.stdout.write(JSON.stringify({
      home: causyneHome(),
      sessions: mods[1].SESSION_DIR,
      usage: new mods[0].TokenTracker().getDailyFile()
    }));
  `;
  try {
    const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, CAUSYNE_HOME: root }, encoding: 'utf8'
    }));
    assert.equal(out.home, root);
    assert.ok(out.sessions.startsWith(root), 'the session store ignored the state root');
    assert.ok(out.usage.startsWith(root), 'the usage store ignored the state root');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('state: the suite itself runs isolated from the real store', () => {
  // If this ever fails, a test run is writing into whoever ran it.
  const real = path.join(os.homedir(), '.causyne');
  assert.notEqual(causyneHome(), real,
    'tests are pointed at the real state directory — see tests/helpers/isolateState.js');
});

test('usage: concurrent tracking does not lose an update', () => {
  // condenseAndSave() is fired WITHOUT await from the agent loop, so its
  // trackUsage runs interleaved with the loop's own. Read-modify-write without
  // a lock means both read 1000 and write 1500 and 1200 — 500 tokens vanish.
  // Under-counting is the dangerous direction: the hard stop fires late and the
  // real invoice exceeds what Causyne displayed.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-race-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    provider: 'muse', model: 'muse-spark-1.3-contributor', tokenBudget: { enabled: false }
  }));
  const script = `
    import { TokenTracker } from '${new URL('../src/tokenTracker.js', import.meta.url).pathname}';
    const t = new TokenTracker();
    await Promise.all(Array.from({ length: 40 }, () => t.trackUsage(100, 0)));
    process.stdout.write(JSON.stringify(await t.getDailyUsage()));
  `;
  try {
    const daily = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, CAUSYNE_HOME: root }, encoding: 'utf8'
    }));
    assert.equal(daily.totalTokens, 4000, 'tokens were lost to an interleaved write');
    assert.equal(daily.totalCalls, 40, 'calls were lost to an interleaved write');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('undo: the conversation snapshot follows the live session file', () => {
  // Chat history moved from one global memory/chat_history.json into per-session
  // files, and migrateLegacyHistory() RENAMES the old one. checkpoints.js was
  // never told, so existsSync() went permanently false and the conversation
  // rewind stopped happening — undo restored the files and left the agent
  // believing in edits that were gone.
  const src = sourceWithoutComments(fileURLToPath(new URL('../src/checkpoints.js', import.meta.url)));

  assert.match(src, /function activeHistoryFile/, 'undo is back on a single fixed history file');
  assert.match(src, /getActiveSessionId/, 'undo no longer follows the active session');
  assert.match(src, /history\.file/, 'the snapshot no longer records which file it came from');
});

test('tasks: one user request is one task', () => {
  // The chat loop assigned cli_chat_<ts> ONCE per session. Checkpoints group by
  // taskId, so `/undo` in a terminal open all day offered to roll back the whole
  // day as one unit. The real store proves it: a single id holding both `hi` and
  // `continue`.
  const src = sourceWithoutComments(fileURLToPath(new URL('../src/cliMode.js', import.meta.url)));
  const turn = src.slice(src.indexOf('loop.userPrompt = task;'));

  assert.match(turn.slice(0, 400), /loop\.taskId = `cli_chat_\$\{Date\.now\(\)\}`/,
    'the taskId is not rotated at the start of a turn');
});

test('undo: a real session conversation is actually rewound', async () => {
  // THE TEST THAT WOULD HAVE CAUGHT THE REGRESSION.
  //
  // tests/checkpoints.test.js writes `memory/chat_history.json` itself and then
  // asserts undo restores it — so it kept passing for hours after production
  // stopped creating that file at all. This one drives the REAL session store:
  // it creates a session the way the agent does, lets a task begin, changes the
  // conversation, and asserts undo put it back. Nothing here fabricates the
  // file under test.
  const { createSession, saveSessionMessages, SESSION_DIR } = await import('../src/sessionStore.js');
  const { beginTask, undoTask, captureBeforeMutation } = await import('../src/checkpoints.js');

  const session = createSession(path.join(os.tmpdir(), 'undo-ws'), 'rewind me');
  saveSessionMessages(session.id, [{ role: 'user', content: 'before the task' }]);
  const sessionFile = path.join(SESSION_DIR, `${session.id}.json`);
  assert.ok(fs.existsSync(sessionFile), 'the session store did not create the file');

  const taskId = `undo_behaviour_${Date.now()}`;
  await beginTask({ taskId, prompt: 'rewind me', workspaceRoots: [] });

  // The agent does some work and the conversation grows.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'undo-files-'));
  const touched = path.join(scratch, 'written.txt');
  captureBeforeMutation('fs_write', { path: touched }, { taskId, step: 1 });
  fs.writeFileSync(touched, 'written by the task\n');
  saveSessionMessages(session.id, [
    { role: 'user', content: 'before the task' },
    { role: 'assistant', content: 'I wrote written.txt' }
  ]);

  try {
    const result = undoTask(taskId, { dryRun: false });

    assert.equal(result.historyRestored, true,
      'undo restored the files and left the conversation claiming the edits happened');

    const rewound = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(rewound.messages.length, 1, 'the conversation did not rewind with the files');
    assert.equal(rewound.messages[0].content, 'before the task');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
