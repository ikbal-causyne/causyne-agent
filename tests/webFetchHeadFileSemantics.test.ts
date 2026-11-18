import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webFetch } from '../src/tools/webFetch.js';

test('web.fetch refuses HEAD downloads that would silently create empty files', async () => {
  const result = await webFetch.execute({url:'https://1.1.1.1/resource',method:'HEAD',outputFile:'resource.bin'});
  assert.equal(result.success,false);
  assert.match(result.error ?? '',/HEAD responses cannot be downloaded/);
});
