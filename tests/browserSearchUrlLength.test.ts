import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicResultUrl, parseBingRss } from '../src/browser/searchProviders.js';

test('untrusted search result URLs are bounded before display or navigation', () => {
  const oversized='https://example.org/?x='+ 'a'.repeat(5_000);
  assert.equal(publicResultUrl(oversized),null);
  const xml='<item><title>Oversized</title><link>'+oversized+'</link><description>Bad</description></item>';
  assert.deepEqual(parseBingRss(xml),[]);
  assert.equal(publicResultUrl('https://example.org/ok'),'https://example.org/ok');
});
