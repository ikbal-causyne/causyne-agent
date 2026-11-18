import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webFetch } from '../src/tools/webFetch.js';

test('web.fetch does not resend state-changing request bodies to a different origin', async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    calls.push(String(input));
    return new Response(null, { status: 307, headers: { location: 'https://8.8.8.8/receive' } });
  }) as typeof fetch;
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const result = await webFetch.execute({url:'https://1.1.1.1/send', method, body:'sensitive'});
      assert.equal(result.success, false);
      assert.match(result.error ?? '', /Cross-origin redirect blocked/);
    }
    assert.equal(calls.length, 4);
    assert.ok(calls.every(url => url === 'https://1.1.1.1/send'));
  } finally { globalThis.fetch = original; }
});
