import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBingRss } from '../src/browser/searchProviders.js';

test('public search results exclude credential URLs and known internal destinations', () => {
  const credentialUrl = new URL('https://example.com/');
  credentialUrl.username = 'user';
  credentialUrl.password = 'pass';
  const links = [
    'http://127.0.0.1/admin', 'http://10.0.0.1/', 'http://[::1]/',
    'https://metadata.google.internal/', 'https://service.local/', credentialUrl.href,
    'https://example.com/public'
  ];
  const xml = '<rss>' + links.map((link, i) =>
    `<item><title>Result ${i}</title><link>${link}</link><description>Test</description></item>`).join('') + '</rss>';
  const results = parseBingRss(xml);
  assert.deepEqual(results.map(result => result.url), ['https://example.com/public']);
});
