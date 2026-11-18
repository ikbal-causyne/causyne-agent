import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webFetch} from '../src/tools/webFetch.js';
test('web.fetch rejects non-string HTTP methods at the execution boundary',async()=>{
 for(const method of [7,{},null]) {
  const r=await webFetch.execute({url:'https://1.1.1.1/',method} as any);
  assert.equal(r.success,false);
  assert.match(r.error??'',/method must be a string/);
 }
});
