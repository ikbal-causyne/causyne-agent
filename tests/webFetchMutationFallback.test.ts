import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webFetch } from '../src/tools/webFetch.js';

test('web.fetch does not replace rejected mutations with an unrelated browser GET', async () => {
  const before = globalThis.fetch;
  globalThis.fetch = (async () => new Response('<h1>Denied</h1>', {
    status: 403, headers: { 'content-type': 'text/html' }
  })) as typeof fetch;
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
      const result = await webFetch.execute({ url: 'https://1.1.1.1/action', method });
      assert.equal(result.success, false, method);
      assert.equal(result.status, 403, method);
      assert.equal('via' in result, false, method);
    }
  } finally { globalThis.fetch = before; }
});
