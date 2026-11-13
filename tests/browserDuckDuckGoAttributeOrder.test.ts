import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuckDuckGoHtml } from '../src/browser/searchProviders.js';

test('DuckDuckGo result links work regardless of HTML attribute ordering', () => {
  const html = [
    '<a href="https://example.org/first" class="result__a">First result</a>',
    '<div class="result__snippet">First excerpt</div>',
    '<a class="result__a" href="https://example.org/second">Second result</a>',
    '<div class="result__snippet">Second excerpt</div>'
  ].join('');
  const results = parseDuckDuckGoHtml(html);
  assert.deepEqual(results.map(result => result.url), ['https://example.org/first', 'https://example.org/second']);
  assert.equal(results[0]?.snippet, 'First excerpt');
});
