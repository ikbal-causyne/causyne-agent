import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskBuffer } from '../src/taskBuffer.js';
import { getMemory, saveMemory, addFact, clearMemory } from '../src/memory.js';
import {
  recordObservation,
  recordActuation,
  readSession,
  describeSession,
  pruneSessions,
  getSessionDir
} from '../src/embodimentSession.js';
import { MemoryManager } from '../src/memoryManager.js';
import { analyzeSource, analyzeFiles, formatFindings } from '../src/slopDetector.js';
import { isCapabilityAllowed, TIER_RANK, CAPABILITY_MIN_RANK } from '../src/capabilities.js';
import { suggestMovements, formatMovementBrief } from '../src/designPalettes.js';
import { canonicalModelId } from '../src/modelIds.js';
import { selectFeatures, FEATURE_MAP } from '../src/verification/featureMap.js';
import { runCliProbe } from '../src/verification/cliProbe.js';
import { verifyCausyneTui } from '../src/verification/uiRuntime.js';
import { LocalCLIConnection } from '../src/cliMode.js';
import { UI } from '../src/utils/cli_ui.js';

function withTempHome<T>(fn: (home: string) => Promise<T> | T): Promise<T> {
  const prev = process.env.CAUSYNE_HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-sec7-test-'));
  process.env.CAUSYNE_HOME = tmp;
  return Promise.resolve()
    .then(() => fn(tmp))
    .finally(() => {
      if (prev === undefined) delete process.env.CAUSYNE_HOME;
      else process.env.CAUSYNE_HOME = prev;
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    });
}

test('TaskBuffer blocks path traversal, handles circular payloads, and tolerates corrupt JSONL lines', async () => {
  await withTempHome(async (home) => {
    const tb = new TaskBuffer();
    const targetPath = tb.getBufferPath('../../etc/passwd');
    assert.ok(targetPath.startsWith(path.join(home, 'buffers') + path.sep));
    assert.ok(!targetPath.includes('..'));

    const circular: Record<string, unknown> = { step: 1 };
    circular.self = circular;
    await tb.appendOutput('safe-task', circular);

    fs.appendFileSync(tb.getBufferPath('safe-task'), '{corrupt-line\n{"ts":1,"ok":true}\n');
    const entries = await tb.getBuffer('safe-task');
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.error, 'unserializable_step_data');
    assert.equal(entries[1]?.ok, true);

    await tb.clearBuffer('safe-task');
    assert.deepEqual(await tb.getBuffer('safe-task'), []);
  });
});

test('memory.ts resolves CAUSYNE_HOME dynamically, writes atomically, and refuses symlinks', async () => {
  await withTempHome((home) => {
    addFact('sector7-dynamic-home-fact');
    const mem = getMemory();
    assert.ok(mem.facts.includes('sector7-dynamic-home-fact'));
    const memPath = path.join(home, 'memory.json');
    assert.ok(fs.existsSync(memPath));

    clearMemory();
    assert.deepEqual(getMemory().facts, []);

    if (process.platform !== 'win32') {
      const outside = path.join(home, 'outside-target.json');
      fs.writeFileSync(outside, '{"facts":["keep-me"]}');
      fs.unlinkSync(memPath);
      fs.symlinkSync(outside, memPath);
      saveMemory({ facts: ['overwrite-attempt'] });
      assert.equal(fs.readFileSync(outside, 'utf8'), '{"facts":["keep-me"]}');
      assert.deepEqual(getMemory().facts, []);
    }
  });
});

test('embodimentSession sanitizes control chars and skips symlinks during prune', async () => {
  await withTempHome(() => {
    const prev = process.env.CAUSYNE_DISABLE_EMBODIMENT_SESSION;
    delete process.env.CAUSYNE_DISABLE_EMBODIMENT_SESSION;
    try {
      recordObservation('t1', 'App\x1b[31mName\nEvil', 'node1\nnode2');
      recordActuation('t1', 'App\x07Name', ['click\x1b[2J', 'type\r\nhello']);
      const state = readSession('t1');
      assert.ok(state);
      assert.ok(!state.app?.includes('\x1b'));
      assert.ok(!state.app?.includes('\x07'));
      const desc = describeSession('t1');
      assert.ok(desc && !desc.includes('\x1b') && !desc.includes('\x07'));

      if (process.platform !== 'win32') {
        const dir = getSessionDir();
        const victim = path.join(path.dirname(dir), 'victim.json');
        fs.writeFileSync(victim, '{}');
        const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
        fs.utimesSync(victim, oldTime, oldTime);
        fs.symlinkSync(victim, path.join(dir, 'escape.json'));
        pruneSessions();
        assert.ok(fs.existsSync(victim), 'pruneSessions must not unlink symlink target');
      }
    } finally {
      if (prev !== undefined) process.env.CAUSYNE_DISABLE_EMBODIMENT_SESSION = prev;
    }
  });
});

test('MemoryManager handles circular message content and nullish history entries without throwing', async () => {
  await withTempHome((home) => {
    const mm = new MemoryManager(home);
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const bounded = mm.boundHistory([
      null,
      undefined,
      { role: 'user', content: circular },
      { role: 'assistant', content: 'ok' }
    ]);
    assert.equal(bounded.length, 2);
  });
});

test('cliProbe strips secret env vars and rejects NUL bytes and protected workspace roots', async () => {
  const prevSecret = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-sector7-secret-should-not-leak';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-cliprobe-sec7-'));
  try {
    const res = await runCliProbe({
      workspace: tmp,
      program: 'node',
      args: ['-e', 'process.stdout.write(process.env.OPENAI_API_KEY || "CLEAN")']
    });
    assert.equal(res.status, 'observed-pass');
    assert.equal(res.stdout, 'CLEAN');

    await assert.rejects(
      runCliProbe({ workspace: `${tmp}\0bad`, program: 'node', args: ['-v'] }),
      /required/
    );
    await assert.rejects(
      runCliProbe({ workspace: path.parse(tmp).root, program: 'node', args: ['-v'] }),
      /protected system root/
    );
    await assert.rejects(
      verifyCausyneTui({ workspace: `${tmp}\0bad` }),
      /valid path string/
    );
  } finally {
    if (prevSecret === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevSecret;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('slopDetector, capabilities, designPalettes, modelIds, and featureMap enforce bounds and freeze invariants', () => {
  const huge = 'a'.repeat(600 * 1024) + 'linear-gradient(' + 'x'.repeat(2000);
  const start = Date.now();
  const res = analyzeSource(huge);
  assert.ok(Date.now() - start < 500, 'bounded scan must complete fast without ReDoS');
  assert.equal(typeof res.score, 'number');
  assert.equal(analyzeFiles(null as unknown as []).verdict, 'clean');
  assert.ok(formatFindings(null as unknown as typeof res).includes('ANTI-SLOP'));

  assert.equal(Object.isFrozen(TIER_RANK), true);
  assert.equal(Object.isFrozen(CAPABILITY_MIN_RANK), true);
  assert.equal(isCapabilityAllowed('__proto__', 'constructor'), true);

  assert.deepEqual(suggestMovements(null as unknown as string[], -5), []);
  assert.equal(formatMovementBrief(null), '');

  const longId = 'claude-' + '1.'.repeat(200);
  assert.equal(canonicalModelId(longId), longId);

  assert.equal(Object.isFrozen(FEATURE_MAP['tui-usage']?.automated), true);
  assert.throws(() => selectFeatures(Array.from({ length: 65 }, () => 'tui-usage')), /Too many features/);
});

test('LocalCLIConnection.send and cli_ui guard malformed frames and sanitize escape sequences', () => {
  const handled: unknown[] = [];
  const conn = new LocalCLIConnection({
    pendingApprovals: new Map(),
    stepCount: 0,
    stopSpinner() {},
    handle(msg: unknown) { handled.push(msg); }
  });
  conn.send('');
  conn.send('null');
  conn.send('"string-not-object"');
  assert.equal(handled.length, 0);
  conn.send(JSON.stringify({ type: 'ok' }));
  assert.equal(handled.length, 1);

  const spinner = UI.createSpinner('hello\x1b[31mworld');
  assert.equal(typeof spinner.start, 'function');
  assert.equal(typeof spinner.stop, 'function');
  assert.equal(typeof spinner.fail, 'function');
});
