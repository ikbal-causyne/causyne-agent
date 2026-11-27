import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { assertPublicWebUrl } from '../src/browser/urlPolicy.js';

test('browser DNS cache evicts old records and expires entries without network access', async (t) => {
  let now = 1_000_000;
  const clock = t.mock.method(Date, 'now', () => now);
  const lookup = t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  syncBuiltinESMExports();
  try {
    const url = (index) => 'https://minor-cache-' + index + '.example.test/';
    for (let i = 0; i < 513; i++) await assertPublicWebUrl(url(i));
    assert.equal(lookup.mock.callCount(), 513);
    await assertPublicWebUrl(url(512));
    assert.equal(lookup.mock.callCount(), 513);
    await assertPublicWebUrl(url(0));
    assert.equal(lookup.mock.callCount(), 514);
    now += 5 * 60_000 + 1;
    await assertPublicWebUrl(url(512));
    assert.equal(lookup.mock.callCount(), 515);
  } finally {
    clock.mock.restore();
    lookup.mock.restore();
    syncBuiltinESMExports();
  }
});
