import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCliProbe } from '../src/verification/cliProbe.js';

const workspace = path.resolve(process.cwd());

test('CLI probe runs a real process and records exit status plus evidence', async () => {
  const result = await runCliProbe({
    workspace, program: 'node', args: ['-e', 'process.stdout.write("READY\\n")'], contains: 'READY'
  });
  assert.equal(result.status, 'observed-pass');
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /READY/);
  assert.match(result.limitation, /does not verify terminal rendering/);
});

test('failed assertions, bad exit codes, and bounded output never count as passes', async () => {
  const missing = await runCliProbe({
    workspace, program: 'node', args: ['-e', 'process.stdout.write("OTHER")'], contains: 'READY'
  });
  assert.equal(missing.status, 'observed-fail');
  const exit = await runCliProbe({
    workspace, program: 'node', args: ['-e', 'process.exit(3)']
  });
  assert.equal(exit.exitCode, 3);
  assert.equal(exit.success, false);
  const huge = await runCliProbe({
    workspace, program: 'node', args: ['-e', 'process.stdout.write("x".repeat(5000))'],
    outputLimit: 64
  });
  assert.equal(huge.truncated, true);
  assert.equal(huge.success, false);
  assert.ok(Buffer.byteLength(huge.stdout) <= 64);
});

test('CLI probe times out and does not claim success', async () => {
  const probe = await runCliProbe({
    workspace, program: 'node', args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 150
  });
  assert.equal(probe.timedOut, true);
  assert.equal(probe.status, 'observed-fail');
});

test('probe refuses unexpected executable and workspace traversal', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-cli-probe-'));
  try {
    await assert.rejects(runCliProbe({
      workspace, program: path.join(outside, 'not-authorized'), args: []
    }), /inside workspace/);
    await assert.rejects(runCliProbe({ workspace, program: 'node', args: [], timeoutMs: -5 }), /timeoutMs/);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
