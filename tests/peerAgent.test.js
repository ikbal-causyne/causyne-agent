import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { peerAgentTool } from '../src/tools/peerAgent.js';
import { loadPeerProfiles, peerProfilesPath, getPeerProfile } from '../src/acp/peerProfiles.js';

const fixture = fileURLToPath(new URL('./fixtures/fakeAcpAgent.js', import.meta.url));

function writePeers(peers) {
  fs.writeFileSync(peerProfilesPath(), JSON.stringify({ schemaVersion: 1, peers }, null, 2));
}

test('peer profiles are validated from the user file', () => {
  writePeers([
    { id: 'good', label: 'Good peer', command: process.execPath, args: [fixture], policy: 'workspace' },
    { id: 'bad id!', command: '/bin/sh' },
    { id: 'good', command: '/bin/sh' },
    { id: 'no-command' },
    { id: 'slow', command: process.execPath, args: [fixture], timeoutSeconds: 999999 }
  ]);
  const profiles = loadPeerProfiles();
  assert.deepEqual(profiles.map((profile) => profile.id).sort(), ['good', 'slow']);
  assert.equal(profiles.find((profile) => profile.id === 'slow').timeoutSeconds, 1800);
  assert.equal(profiles.find((profile) => profile.id === 'slow').policy, 'read-only');
});

test('peer delegation rejects unknown profiles with guidance', async () => {
  writePeers([]);
  const result = await peerAgentTool.execute({ peer: 'missing', prompt: 'review this' });
  assert.equal(result.success, false);
  assert.match(result.error, /Unknown peer profile/);
});

test('peer delegation rejects a missing prompt', async () => {
  const result = await peerAgentTool.execute({ peer: 'anything', prompt: '' });
  assert.equal(result.success, false);
  assert.match(result.error, /prompt/i);
});

test('peer delegation completes an ACP round-trip and allows workspace writes', async () => {
  writePeers([
    { id: 'workspace-peer', command: process.execPath, args: [fixture], policy: 'workspace', timeoutSeconds: 30 }
  ]);
  const result = await peerAgentTool.execute({ peer: 'workspace-peer', prompt: 'write a file' });
  assert.equal(result.success, true);
  assert.match(result.output, /peer says hello/);
  assert.match(result.output, /approved/);
});

test('read-only peers reject mutating permission requests', async () => {
  writePeers([
    { id: 'read-only-peer', command: process.execPath, args: [fixture], policy: 'read-only', timeoutSeconds: 30 }
  ]);
  const result = await peerAgentTool.execute({ peer: 'read-only-peer', prompt: 'write a file' });
  assert.equal(result.success, true);
  assert.match(result.output, /rejected/);
});

test('peer delegation reports a failed executable', async () => {
  writePeers([
    { id: 'broken-peer', command: path.join(peerProfilesPath(), 'does-not-exist'), policy: 'read-only' }
  ]);
  const result = await peerAgentTool.execute({ peer: 'broken-peer', prompt: 'hello' });
  assert.equal(result.success, false);
  assert.match(result.error, /ENOTDIR|ENOENT|failed|EACCES/i);
});

test('peerAgentTool action list returns peer catalog and preset names', async () => {
  const result = await peerAgentTool.execute({ action: 'list' });
  assert.equal(result.success, true);
  assert.ok(Array.isArray(result.peers));
  assert.match(result.output, /Built-in presets supported:/);
  assert.match(result.output, /opencode/);
  assert.match(result.output, /claude/);
});

test('peer profile resolves built-in presets when not explicitly configured', () => {
  writePeers([]);
  const opencode = getPeerProfile('opencode');
  assert.ok(opencode);
  assert.equal(opencode.id, 'opencode');
  assert.equal(opencode.command, 'opencode');
  assert.deepEqual(opencode.args, ['acp']);
  assert.equal(opencode.policy, 'read-only');
});

test('testPeerHandshake succeeds against fixture', async () => {
  const { testPeerHandshake } = await import('../src/acp/agentCatalog.js');
  const handshake = await testPeerHandshake({
    command: process.execPath,
    args: [fixture],
    timeoutMs: 5000
  });
  assert.equal(handshake.ready, true);
  assert.equal(handshake.agentInfo?.name, 'Fake Peer');
  assert.equal(handshake.agentInfo?.version, '1.0.0');
});

test('auth failure returns helpful diagnostic guidance', async () => {
  writePeers([
    {
      id: 'auth-failing-peer',
      command: process.execPath,
      args: [fixture],
      env: { SIMULATE_AUTH_ERROR: '1' },
      policy: 'read-only',
      timeoutSeconds: 10
    }
  ]);
  const result = await peerAgentTool.execute({ peer: 'auth-failing-peer', prompt: 'do something' });
  assert.equal(result.success, false);
  assert.match(result.error, /Authentication required/i);
});

test('/peers slash command handles detect, list, test, add, remove', async () => {
  const { runCommand } = await import('../src/commands.js');

  const listRes = await runCommand('peers', []);
  assert.equal(listRes.ok, true);
  assert.match(listRes.output, /Configured & Preset ACP Peer Agents/);

  const detectRes = await runCommand('peers', ['detect']);
  assert.equal(detectRes.ok, true);
  assert.match(detectRes.output, /Discovered ACP Peer Agents/);

  const addRes = await runCommand('peers', ['add', 'my-test-peer', process.execPath, fixture]);
  assert.equal(addRes.ok, true);
  assert.match(addRes.output, /Added peer "my-test-peer"/);

  const testRes = await runCommand('peers', ['test', 'my-test-peer']);
  assert.equal(testRes.ok, true);
  assert.match(testRes.output, /ACP Peer Test Passed/);

  const removeRes = await runCommand('peers', ['remove', 'my-test-peer']);
  assert.equal(removeRes.ok, true);
  assert.match(removeRes.output, /Removed peer profile "my-test-peer"/);
});

test.after(() => {
  try {
    fs.writeFileSync(peerProfilesPath(), JSON.stringify({ schemaVersion: 1, peers: [] }, null, 2));
  } catch {}
});
