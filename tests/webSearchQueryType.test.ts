import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webSearch} from '../src/tools/webSearch.js';
test('web_search rejects invalid query types rather than searching object coercions',async()=>{
 for (const query of [{q:'hidden'},['secret'],42,null]) {
  const result=await webSearch.execute({query} as any);
  assert.equal(result.success,false);
  assert.match(result.error,/query must be a string/);
 }
});
