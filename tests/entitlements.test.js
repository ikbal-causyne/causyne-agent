import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EntitlementClient, EntitlementGate, EntitlementAccessError, loadInstallationIdentity } from '../src/licensing/entitlements.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-entitle-test-')); }
const installationId = '30303030-3030-4030-8030-303030303030';

test('installation identity is a persistent local keypair, not hardware fingerprint', () => {
  const root = tmp();
  try {
    const first = loadInstallationIdentity(root);
    const second = loadInstallationIdentity(root);
    assert.equal(first.publicKey, second.publicKey);
    assert.equal(first.privateKeyPem, second.privateKeyPem);
    assert.match(first.privateKeyPem, /BEGIN PRIVATE KEY/);
    assert.equal(fs.existsSync(path.join(root, 'installation-identity.json')), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('anonymous registration and status use Ed25519 signed request', async () => {
  const root = tmp(); const calls = [];
  const fetchFn = async (url, options) => {
    const requestPath = new URL(url).pathname;
    calls.push({ requestPath, options });
    if (requestPath === '/v1/installations') {
      const body = JSON.parse(options.body);
      const pub = crypto.createPublicKey({ key: Buffer.from(body.publicKey, 'base64url'), type: 'spki', format: 'der' });
      const ok = crypto.verify(null, Buffer.from(`CAUSYNE_REGISTER_V1\n${body.publicKey}\n${body.nonce}`),
        pub, Buffer.from(body.proof, 'base64url'));
      assert.equal(ok, true);
      return Response.json({ installationId }, { status: 201 });
    }
    assert.equal(requestPath, '/v1/status');
    const identity = loadInstallationIdentity(root);
    const pub = crypto.createPublicKey({ key: Buffer.from(identity.publicKey, 'base64url'), type: 'spki', format: 'der' });
    const { 'x-causyne-timestamp': timestamp, 'x-causyne-nonce': nonce,
      'x-causyne-signature': signature, 'x-causyne-installation': id } = options.headers;
    assert.equal(id, installationId);
    const digest = crypto.createHash('sha256').update('').digest('base64url');
    const msg = `CAUSYNE_API_V1\nGET\n/v1/status\n${timestamp}\n${nonce}\n${digest}`;
    assert.equal(crypto.verify(null, Buffer.from(msg), pub, Buffer.from(signature, 'base64url')), true);
    return Response.json({ entitlement: 'free', dailySeconds: 21600, usedSeconds: 0, remainingSeconds: 21600 });
  };
  try {
    const client = new EntitlementClient({ apiBase: 'https://license.causyne.com', stateRoot: root, fetchFn });
    const s = await client.status();
    assert.equal(s.remainingSeconds, 21600);
    assert.equal(calls.length, 2);
    const persisted = loadInstallationIdentity(root);
    assert.equal(persisted.installationId, installationId);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('entitlement gate authorizes a task and stops when quota is rejected', async () => {
  const future = () => new Date(Date.now() + 1200).toISOString();
  let count = 0;
  const client = { async lease() {
    count++;
    if (count > 1) throw new EntitlementAccessError('FREE_LIMIT', 'Daily allowance exhausted.');
    return { expiresAt: future(), plan: 'free', chargeSeconds: 60 };
  } };
  const gate = new EntitlementGate({ enabled: true, client });
  const blocked = [];
  await gate.begin(error => blocked.push(error.code));
  assert.equal(gate.activeRuns, 1);
  await gate.beforeStep();
  gate.leaseUntil = 0;
  await assert.rejects(gate.beforeStep(), { code: 'FREE_LIMIT' });
  gate.end();
  assert.equal(gate.activeRuns, 0);
  assert.equal(gate.timer, null);
});
