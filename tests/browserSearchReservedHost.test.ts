import { test } from 'node:test';
import assert from 'node:assert/strict';
import {publicResultUrl} from '../src/browser/searchProviders.js';
test('search result URLs reject reserved and non-public special-use domains', () => {
 for (const name of ['foo.invalid','tool.test','machine.example','hidden.onion','localhost.localdomain']) {
   assert.equal(publicResultUrl('https://'+name+'/data'),null,name);
 }
 assert.equal(publicResultUrl('https://example.com/data'),'https://example.com/data');
});
