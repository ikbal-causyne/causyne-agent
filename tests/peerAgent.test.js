import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { peerAgentTool } from '../src/tools/peerAgent.js';
import { loadPeerProfiles, peerProfilesPath } from '../src/acp/peerProfiles.js';

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
