import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { TokenTracker } from '../src/tokenTracker.js';
import { StatusLine } from '../src/tui/statusLine.js';
import { contextMeter } from '../src/tui/block.js';
import { CHARS_PER_TOKEN, CHAR_POOLS } from '../src/contextManager.js';

// Read a source file with comments removed.
//
// Every one of these guards asserts that a bug is ABSENT from the code, and the
// code documents the bug by quoting it. Grepping raw source therefore matches
// the explanation and fails on a file that is correct — the ZM-09 trap, hit
// three times already in this repo.
function sourceWithoutComments(relative) {
  const raw = fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
  return raw
    .split('\n')
    .filter((line) => {
      const s = line.trim();
      return !s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*');
    })
    .join('\n');
}

/**
 * Run a snippet against the REAL TokenTracker under a throwaway HOME.
 *
 * trackUsage() writes to ~/.causyne/usage/ and re-reads ~/.causyne/config.json on
 * every call, so a test that exercises it in-process both (a) cannot inject a
 * budget and (b) charges the owner's real daily counter for phantom usage. An
 * earlier draft of this file did exactly that and put 6,020 tokens it had never
 * spent into the store — the same carelessness these tests exist to catch.
 */
function trackerUnderTempHome(budget, calls) {
  // CAUSYNE_HOME rather than HOME: the parent already sets it, so a child that
  // only overrode HOME inherited the parent's state root and wrote there.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-budget-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    provider: 'muse', model: 'muse-spark-1.3-contributor', tokenBudget: budget
  }));

  const script = `
    import { TokenTracker } from '${new URL('../src/tokenTracker.js', import.meta.url).pathname}';
    const t = new TokenTracker();
    let r = null;
    for (const [p, c] of ${JSON.stringify(calls)}) r = await t.trackUsage(p, c);
    process.stdout.write(JSON.stringify(r));
  `;
  try {
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, CAUSYNE_HOME: home }, encoding: 'utf8'
    }));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('usage: the budget bar and the daily limiter read the same number', () => {
  // THE BUG. `usedTokens` meant the DAILY total in getReportedUsage() and the
  // TASK total in trackUsage(). The phone renders whatever arrives against
  // maxTokensPerDay, so mid-task it drew 290,069 task tokens against a
  // 1,000,000 daily limit — a bar at 29% at the instant the daily counter hit
  // 1,001,877 and killed the run. The user is entitled to see the wall coming.
  const result = trackerUnderTempHome({ enabled: false }, [[1000, 200]]);

  assert.equal(result.usedTokens, result.dailyTokens,
    'usedTokens drifted away from the daily total the display assumes');
  assert.equal(result.taskTokens, 1200, 'the task scope lost its own number');
  assert.equal(result.dailyTokens, 1200);
  assert.ok('dailyCostUsd' in result && 'taskCostUsd' in result,
    'cost has to name its scope for the same reason tokens do');
});

test('usage: a hard stop still reports the daily figure it stopped on', () => {
  const result = trackerUnderTempHome(
    { enabled: true, hardStop: true, maxTokensPerDay: 500 },
    [[400, 0], [400, 0]]
  );

  assert.equal(result.allowed, false, 'the daily ceiling did not hold');
  assert.equal(result.usedTokens, result.dailyTokens,
    'the frame announcing the stop disagreed with itself');
  assert.equal(result.dailyTokens, 800, 'the daily counter is not what the limiter compared');
  assert.ok(result.reason.includes('800'),
    'the reason quotes a number the frame does not carry');
});

test('usage: the daily bucket is the USER\'S day, not UTC', () => {
  // In WIB (UTC+7) a UTC bucket rolls over at 07:00 local: morning work is
  // charged to yesterday, and the reset lands mid-morning. The live store shows
  // it — a file named 2026-09-09.json last written at 03:23 on Sep 10 local.
  const tracker = new TokenTracker();
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const expected = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;

  assert.equal(path.basename(tracker.getDailyFile()), expected,
    'the daily budget resets at a time the user cannot predict');

  const source = sourceWithoutComments('../src/tokenTracker.js');
  assert.ok(!/toISOString\(\)\.split\('T'\)\[0\]/.test(source),
    'UTC date bucketing is back');
});

test('usage: the daemon sends the field the phone has always read', () => {
  // AgentViewModel: optInt("dailyTokens", optInt("usedTokens", ...)), with the
  // fallback commented "for older daemon versions". The daemon never sent
  // dailyTokens at all, so every client took the fallback — a contract that
  // existed on one side only.
  const source = sourceWithoutComments('../src/agentLoop.js');
  const frame = source.slice(source.indexOf("type: 'usage_update'"));

  for (const field of ['dailyTokens', 'dailyCostUsd', 'taskTokens', 'contextChars']) {
    assert.ok(new RegExp(`${field}:`).test(frame.slice(0, 900)),
      `usage_update stopped carrying ${field} — the phone falls back to a different scope`);
  }
});

test('context meter: both sides of the ratio are the same unit', () => {
  // A cumulative TOKEN count over a CHARACTER pool. Two unit errors compounding.
  const usedChars = 30000;
  const limitChars = CHAR_POOLS.default;

  const meter = contextMeter(
    Math.round(usedChars / CHARS_PER_TOKEN),
    Math.round(limitChars / CHARS_PER_TOKEN)
  );
  assert.match(meter, /\(25%\)/, '30K chars of a 120K pool is a quarter, however it is displayed');
});

test('context meter: an overflowing window says so', () => {
  // Math.min(99, ...) is what let 242% render as a plausible "99%" for a whole
  // session. A meter that cannot report "over" cannot report the one state
  // worth acting on.
  assert.match(contextMeter(290069, 30000), /\((\d{3,})%\)/,
    'the meter is clamped again and can no longer show an overflow');

  const source = sourceWithoutComments('../src/tui/block.js');
  assert.ok(!/Math\.min\(99,/.test(source), 'the 99% clamp is back');
});

test('status line: the working line shows the task, the meter shows the window', () => {
  const status = new StatusLine();
  status.setSession({ model: 'muse-spark-1.3-contributor', cwd: '/tmp', contextLimit: CHAR_POOLS.default });

  status.onUsage({
    usedTokens: 1001877,   // daily — for the phone's budget card
    dailyTokens: 1001877,
    taskTokens: 290069,    // task — what this run has spent
    contextChars: 30000,
    contextLimitChars: CHAR_POOLS.default
  });

  assert.equal(status.turnTokens, 290069,
    'the working line showed the daily total instead of the turn the user is deciding on');

  const idle = status.renderIdle({ width: 100 });
  assert.match(idle, /\(25%\)/, 'the idle footer is not reporting real window occupancy');
  assert.ok(!/99%/.test(idle), 'the footer is pinned at 99% again');
});

test('media playbook: a failed `which` is not proof a tool is missing', () => {
  // The Blender mandate cured one symptom. The agent then hand-wrote an encode
  // script, ran `which ffmpeg || ls /opt/homebrew/bin/ffmpeg`, took the failure
  // as final, and burned four steps re-solving what blender_act already does.
  const { PACK_PLAYBOOKS } = require_playbooks();
  const media = PACK_PLAYBOOKS.media;

  assert.match(media, /which ffmpeg/, 'the ffmpeg PATH trap is not called out');
  assert.match(media, /render_animation/, 'the playbook never names the encoder already installed');
  assert.match(media, /Never infer installation from PATH alone/,
    'the mandate is still scoped to Blender alone');
});

function require_playbooks() {
  // Kept as a function so the assertion above reads as one thought.
  return globalThis.__causynePlaybooks;
}

test.before(async () => {
  globalThis.__causynePlaybooks = await import('../src/toolPacks.js');
});
