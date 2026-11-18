import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBingRss, parseDuckDuckGoHtml } from '../src/browser/searchProviders.js';

test('search results cannot inject terminal controls or bidirectional text controls', () => {
  const xml='<rss><item><title>Hi\u001b[2J\u202eunsafe</title><link>https://example.org/one</link><description>Line\u0007beep</description></item></rss>';
  const rss=parseBingRss(xml);
  assert.equal(rss.length,1);
  assert.doesNotMatch(rss[0].title,/\u001b|\u202e|\u0007/);
  assert.doesNotMatch(rss[0].snippet,/\u001b|\u202e|\u0007/);
  const html='<a class="result__a" href="https://example.org/two">A\u001b[0mB</a><div class="result__snippet">Hello\u001b[1Gworld</div>';
  const ddg=parseDuckDuckGoHtml(html);
  assert.equal(ddg.length,1);
  assert.doesNotMatch(ddg[0].title,/\u001b/);
  assert.doesNotMatch(ddg[0].snippet,/\u001b/);
});
