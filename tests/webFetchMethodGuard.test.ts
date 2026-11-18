import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webFetch } from '../src/tools/webFetch.js';

test('web.fetch rejects unsupported HTTP verbs even when dispatch bypasses its schema', async () => {
  for (const method of ['CONNECT', 'TRACE', 'OPTIONS', 'WHATEVER']) {
    const result = await webFetch.execute({ url: 'https://1.1.1.1/', method });
    assert.equal(result.success, false, method);
    assert.match(result.error ?? '', /Unsupported HTTP method/);
  }
});
