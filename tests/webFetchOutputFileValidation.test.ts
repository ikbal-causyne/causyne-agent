import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webFetch} from '../src/tools/webFetch.js';
test('web.fetch rejects invalid download destinations before making network requests',async()=>{
 for(const outputFile of [{path:'a'},[],42,'','   ']) {
  const r=await webFetch.execute({url:'https://1.1.1.1/',outputFile} as any);
  assert.equal(r.success,false);
  assert.match(r.error??'',/outputFile must be a non-empty string/);
 }
});
