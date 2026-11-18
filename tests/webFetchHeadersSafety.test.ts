import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webFetch } from '../src/tools/webFetch.js';

test('web.fetch rejects caller-controlled transport headers before requesting a URL', async () => {
  for (const header of ['Host', 'Content-Length', 'Transfer-Encoding', 'Connection', 'Proxy-Authorization', 'Upgrade']) {
    const result = await webFetch.execute({ url: 'https://1.1.1.1/', headers: { [header]: 'attacker.example' } });
    assert.equal(result.success, false, header);
    assert.match(result.error ?? '', /invalid name or value/);
  }
});
