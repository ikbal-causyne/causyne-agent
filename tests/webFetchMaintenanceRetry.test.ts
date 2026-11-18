import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webFetch} from '../src/tools/webFetch.js';
test('service 503 Retry-After is preserved without a browser retry',async()=>{
 const old=globalThis.fetch;let calls=0;
 globalThis.fetch=(async()=>{calls++;return new Response('Maintenance',{status:503,headers:{'retry-after':'300','content-type':'text/html'}})}) as typeof fetch;
 try{
  const r=await webFetch.execute({url:'https://1.1.1.1/maintenance'});
  assert.equal(r.success,false); assert.equal(r.retryAfter,'300'); assert.equal(r.status,503);
  assert.equal(calls,1);
 }finally{globalThis.fetch=old;}
});
