import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToReadableText } from '../src/tools/webFetch.js';

test('web.fetch decoding survives malformed and uppercase numeric HTML entities', () => {
  const input = 'A &#X1F600; B &#x110000; C &#0; D &#xD800; E &AMP;';
  assert.equal(htmlToReadableText(input), 'A 😀 B &#x110000; C &#0; D &#xD800; E &');
});
