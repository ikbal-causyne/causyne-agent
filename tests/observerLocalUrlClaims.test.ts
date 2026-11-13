import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractClaimedLocalUrls } from '../src/observer.js';

test('local server claims are checked without requiring an explicit port', () => {
  const claims = extractClaimedLocalUrls('Available at http://localhost/app and http://[::1]/. Also http://127.0.0.1:8080/status!');
  assert.deepEqual(claims, ['http://localhost/app', 'http://[::1]/', 'http://127.0.0.1:8080/status']);
});

test('lookalike hostnames are not interpreted as real localhost server claims', () => {
  const claims = extractClaimedLocalUrls('http://localhost.attacker.example:3333/ is not loopback; neither is http://127.0.0.1.example:4444/');
  assert.deepEqual(claims, []);
});
