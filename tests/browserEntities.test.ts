import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBingRss } from '../src/browser/searchProviders.js';

test('invalid numeric HTML entities cannot crash lightweight search parsing', () => {
  const rows = parseBingRss('<rss><item><title>API &#X41; &#x110000; &#xD800; &#0;</title><link>https://example.com/docs</link><description>Valid &#65; and invalid &#xFFFFFF;</description></item></rss>');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.title, 'API A &#x110000; &#xD800; &#0;');
  assert.equal(rows[0]?.snippet, 'Valid A and invalid &#xFFFFFF;');
});
