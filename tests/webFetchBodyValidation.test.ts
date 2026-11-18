import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webFetch } from '../src/tools/webFetch.js';

test('web.fetch rejects structured bodies instead of silently stringifying them', async () => {
  const result = await webFetch.execute({url:'https://1.1.1.1/post',method:'POST',body:{token:'secret'} as unknown as string});
  assert.equal(result.success,false);
  assert.match(result.error ?? '',/body must be a string/);
});
