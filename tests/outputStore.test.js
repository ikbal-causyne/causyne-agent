// A1 — the tool-output spill store.
//
// The regression this exists for: an oversized tool result was truncated to
// 32k chars and the overflow was DESTROYED, while the decay stub told the model
// "Re-run the tool". Recovering one missing line therefore cost a second full
// tool execution plus a second full-size payload in the window. These tests pin
// the behaviour that replaced it — the bytes survive on disk and the model is
// pointed at a path instead.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Redirect HOME before importing, so nothing here touches the developer's real
// ~/.causyne state. Node resolves os.homedir() from HOME on POSIX and
// USERPROFILE on Windows.
const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
const SANDBOX_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-spill-')));
process.env.HOME = SANDBOX_HOME;
process.env.USERPROFILE = SANDBOX_HOME;
// CAUSYNE_HOME is what every store reads now; hijacking HOME redirected
// os.homedir() for the whole process and still missed the state root.
process.env.CAUSYNE_HOME = path.join(SANDBOX_HOME, '.causyne');

const {
  spillToolOutput,
  spillToolResult,
  renderSpillDocument,
  buildSpillNotice,
  buildDecayPointer,
  pruneOutputStore,
  listSpills,
  getOutputDir,
  isSpillEnabled
} = await import('../src/outputStore.js');

after(() => {
  process.env.HOME = REAL_HOME;
  process.env.USERPROFILE = REAL_USERPROFILE;
  try { fs.rmSync(SANDBOX_HOME, { recursive: true, force: true }); } catch (e) {}
});

describe('spill: the payload survives', () => {
  test('the complete output is written to disk, not just the preview', () => {
    const body = Array.from({ length: 5000 }, (_, i) => `line ${i} of a very large tool result`).join('\n');
    const spill = spillToolOutput(body, { taskId: 'task1', step: 3, tool: 'sysRun' });

    assert.ok(spill, 'a spill should have been produced');
    assert.equal(fs.readFileSync(spill.path, 'utf8'), body, 'the file must hold the FULL output');
    assert.equal(spill.lines, 5000);
    assert.equal(spill.bytes, Buffer.byteLength(body, 'utf8'));
  });

  test('the preview stays small — it is the part that costs context', () => {
    const body = 'x'.repeat(500000);
    const spill = spillToolOutput(body, { taskId: 'task2', step: 1, tool: 'fs_read' });

    assert.ok(spill.preview.length <= 4000, `preview was ${spill.preview.length} chars`);
    assert.ok(spill.bytes > spill.preview.length * 10, 'the spill must be far larger than what re-enters context');
  });

  test('the file lands inside the output directory with owner-only permissions', () => {
    const spill = spillToolOutput('some output', { taskId: 'task3', step: 0, tool: 'gitOp' });
    assert.ok(spill.path.startsWith(getOutputDir() + path.sep));

    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(spill.path).mode & 0o777, 0o600);
    }
  });
});

describe('spill: the document must be readable by the tools we name', () => {
  // The regression: spilling JSON.stringify(result) escapes every newline, so a
  // 900 KB payload landed as ONE line. fs_read line ranges and
  // code_search_ripgrep are both line-oriented, so the notice was pointing the
  // model at a file neither of them could use.
  test('a large result keeps its line structure on disk', () => {
    const body = Array.from({ length: 5000 }, (_, i) => `log line ${i}`).join('\n');
    const spill = spillToolResult({ success: true, output: body }, { taskId: 'lines', step: 1, tool: 'sysRun' });

    assert.ok(spill.lines > 4990, `expected thousands of lines, got ${spill.lines}`);

    const onDisk = fs.readFileSync(spill.path, 'utf8');
    assert.ok(onDisk.includes('log line 2500'), 'the raw text must be present unescaped');
    assert.ok(!onDisk.includes('\\n'), 'no escaped newline sequences may survive into the file');
  });

  test('the document is labelled with the tool, task and step that produced it', () => {
    const doc = renderSpillDocument(
      { success: true, output: 'x'.repeat(600) },
      { taskId: 'abc', step: 4, tool: 'gitOp' }
    );
    assert.match(doc, /CAUSYNE TOOL OUTPUT/);
    assert.match(doc, /tool : gitOp/);
    assert.match(doc, /step: 4/);
    assert.match(doc, /field: output/);
  });

  test('small scalar fields stay in the header rather than becoming sections', () => {
    const doc = renderSpillDocument({ success: false, exitCode: 127, output: 'y'.repeat(600) }, {});
    assert.match(doc, /success: false/);
    assert.match(doc, /exitCode: 127/);
  });

  test('a plain string result passes through untouched', () => {
    assert.equal(renderSpillDocument('already text'), 'already text');
  });
});

describe('spill: the model is told where to look', () => {
  test('the notice names the path and forbids the re-run', () => {
    const spill = spillToolOutput('payload', { taskId: 'task4', step: 2, tool: 'sysRun' });
    const notice = buildSpillNotice(spill);

    assert.ok(notice.includes(spill.path), 'the notice must carry the exact path');
    assert.match(notice, /DO NOT re-run/i);
    assert.match(notice, /fs_read|code_search_ripgrep/);
  });

  test('with no spill the notice degrades honestly instead of naming a file', () => {
    const notice = buildSpillNotice(null);
    assert.match(notice, /TRUNCATED/);
    assert.ok(!notice.includes('saved at'), 'must not promise a file that does not exist');
  });

  test('the decay pointer is empty for a result that was never spilled', () => {
    assert.equal(buildDecayPointer(null), '');
    assert.equal(buildDecayPointer({ path: undefined }), '');
  });

  test('the decay pointer routes to the file rather than to a re-run', () => {
    const pointer = buildDecayPointer({ path: '/tmp/causyne/tool_x.txt' });
    assert.ok(pointer.includes('/tmp/causyne/tool_x.txt'));
    assert.match(pointer, /instead of re-running/i);
  });
});

describe('spill: untrusted metadata cannot escape the directory', () => {
  test('a traversal in taskId is stripped, not honoured', () => {
    // taskId arrives from the phone and from the CLI: it is attacker-reachable.
    const spill = spillToolOutput('payload', {
      taskId: '../../../../etc/passwd',
      step: '../..',
      tool: '../../evil'
    });

    assert.ok(spill, 'the spill should still succeed');
    const resolved = path.resolve(spill.path);
    assert.ok(
      resolved.startsWith(path.resolve(getOutputDir()) + path.sep),
      `spill escaped the store: ${resolved}`
    );
    assert.ok(!spill.path.includes('..'), 'no traversal segment may survive into the filename');
  });
});

describe('spill: retention', () => {
  test('prune removes outputs past the window and keeps fresh ones', () => {
    const stale = spillToolOutput('old output', { taskId: 'old', step: 1, tool: 'sysRun' });
    const fresh = spillToolOutput('new output', { taskId: 'new', step: 1, tool: 'sysRun' });

    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.utimesSync(stale.path, eightDaysAgo / 1000, eightDaysAgo / 1000);

    const removed = pruneOutputStore();

    assert.ok(removed >= 1, 'the stale spill should have been pruned');
    assert.equal(fs.existsSync(stale.path), false);
    assert.equal(fs.existsSync(fresh.path), true, 'a fresh spill must survive');
  });

  test('listSpills reports newest first', () => {
    const spills = listSpills(50);
    assert.ok(Array.isArray(spills));
    for (let i = 1; i < spills.length; i++) {
      assert.ok(spills[i - 1].modified >= spills[i].modified, 'listing must be newest-first');
    }
  });
});

describe('spill: it never breaks a task', () => {
  test('an empty or non-string payload is declined rather than written', () => {
    assert.equal(spillToolOutput('', { taskId: 't' }), null);
    assert.equal(spillToolOutput(null, { taskId: 't' }), null);
    assert.equal(spillToolOutput(undefined, { taskId: 't' }), null);
  });

  test('CAUSYNE_OUTPUT_SPILL=0 turns the feature off', () => {
    const previous = process.env.CAUSYNE_OUTPUT_SPILL;
    process.env.CAUSYNE_OUTPUT_SPILL = '0';
    try {
      assert.equal(isSpillEnabled(), false);
      assert.equal(spillToolOutput('payload', { taskId: 'off' }), null);
    } finally {
      if (previous === undefined) delete process.env.CAUSYNE_OUTPUT_SPILL;
      else process.env.CAUSYNE_OUTPUT_SPILL = previous;
    }
    assert.equal(isSpillEnabled(), true);
  });

  test('an unwritable store fails open — returns null, never throws', () => {
    if (process.platform === 'win32') return; // chmod semantics differ

    const dir = getOutputDir();
    fs.mkdirSync(dir, { recursive: true });
    const originalMode = fs.statSync(dir).mode;
    fs.chmodSync(dir, 0o500); // read+execute, no write
    try {
      let result;
      assert.doesNotThrow(() => {
        result = spillToolOutput('payload', { taskId: 'readonly', step: 1, tool: 'sysRun' });
      });
      assert.equal(result, null, 'a failed spill must degrade to plain truncation');
    } finally {
      fs.chmodSync(dir, originalMode);
    }
  });
});

describe('spill: zero-malware compliance', () => {
  const source = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'outputStore.js'),
    'utf8'
  );

  test('the module reaches for no shell or process-spawning capability', () => {
    // ZM-04: these tokens must never reach the bytecode. This module has no
    // reason to hold any of them — it only touches the filesystem.
    for (const forbidden of ['child_process', 'execSync', 'spawnSync', 'exec(', 'eval(']) {
      assert.ok(!source.includes(forbidden), `outputStore.js must not contain "${forbidden}"`);
    }
  });

  test('the internal spillPath field is stripped before it can reach a provider', () => {
    const base = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'providers', 'base.js'),
      'utf8'
    );
    assert.match(
      base,
      /INTERNAL_MESSAGE_FIELDS\s*=\s*\[[^\]]*'spillPath'/,
      'spillPath must be listed in INTERNAL_MESSAGE_FIELDS or providers will reject the message'
    );
  });
});
