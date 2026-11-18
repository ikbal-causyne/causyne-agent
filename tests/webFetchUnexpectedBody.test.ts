import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webFetch } from '../src/tools/webFetch.js';

test('web.fetch never silently discards a supplied GET or HEAD body', async () => {
  for (const method of ['GET', 'HEAD']) {
    const result = await webFetch.execute({ url: 'https://1.1.1.1/', method, body: 'payload' });
    assert.equal(result.success, false, method);
    assert.match(result.error ?? '', /cannot contain a body/);
  }
});
