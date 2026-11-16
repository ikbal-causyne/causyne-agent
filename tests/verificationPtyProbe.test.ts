import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runPtyProbe } from '../src/verification/ptyProbe.js';

const workspace = path.resolve(process.cwd());

test('real PTY probe drives a TTY child through stdin and records evidence', async t => {
  if (process.platform === 'win32') return t.skip('POSIX PTY only');
  const result = await runPtyProbe({
    workspace, program: 'node',
    args: ['-e', "process.stdout.write('TTY:'+Boolean(process.stdout.isTTY)+'\\n'); process.stdin.once('data', d => { process.stdout.write('RECEIVED:'+d.toString('utf8').trim()+'\\n'); process.exit(0); });"],
    input: 'probe-enter\n', inputDelayMs: 150, timeoutMs: 4000,
    contains: 'RECEIVED:probe-enter'
  });
  if (result.status === 'unavailable') return t.skip(result.reason);
  assert.equal(result.status, 'observed-pass', JSON.stringify(result));
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /TTY:true/);
  assert.match(result.stdout, /RECEIVED:probe-enter/);
  assert.equal(result.surface, 'posix-pty');
});

test('PTY evidence never passes when expected terminal output is absent', async t => {
  if (process.platform === 'win32') return t.skip('POSIX PTY only');
  const result = await runPtyProbe({
    workspace, program: 'node',
    args: ['-e', "process.stdout.write('OTHER'); process.exit(0)"],
    contains: 'ABSENT', inputDelayMs: 50, timeoutMs: 3000
  });
  if (result.status === 'unavailable') return t.skip(result.reason);
  assert.equal(result.status, 'observed-fail');
  assert.equal(result.exitCode, 0);
});

test('PTY command restrictions reject out-of-workspace executables', async () => {
  await assert.rejects(runPtyProbe({
    workspace, program: process.execPath, args: ['-e', 'process.exit(0)']
  }), /inside workspace/);
  await assert.rejects(runPtyProbe({ workspace, program: 'sh' }), /Only node/);
  await assert.rejects(runPtyProbe({ workspace, maxSteps: 1, timeoutMs: 0 }), /limits/);
});

test('an output-only PTY probe can verify observed exit and stdout without injected input', async t => {
  if (process.platform === 'win32') return t.skip('POSIX PTY only');
  const result = await runPtyProbe({
    workspace, program: 'node',
    args: ['-e', "process.stdout.write('READY'); process.exit(0)"],
    contains: 'READY', inputDelayMs: 50, timeoutMs: 3000
  });
  if (result.status === 'unavailable') return t.skip(result.reason);
  assert.equal(result.status, 'observed-pass', JSON.stringify(result));
  assert.equal(result.inputSent, true);
  assert.equal(result.exitCode, 0);
});
