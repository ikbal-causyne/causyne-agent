import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webFetch} from '../src/tools/webFetch.js';
test('web.fetch rejects unsolicited partial files instead of calling them complete',async()=>{
 const old=globalThis.fetch; let cancelled=false;
 globalThis.fetch=(async()=>new Response(new ReadableStream({
   start(c){c.enqueue(new Uint8Array([1,2]));},
   cancel(){cancelled=true;}
 }),{status:206,headers:{'content-range':'bytes 0-1/300'}})) as typeof fetch;
 try{
  const r=await webFetch.execute({url:'https://1.1.1.1/file',outputFile:'file.bin'});
  assert.equal(r.success,false);
  assert.equal(r.status,206);
  assert.equal(cancelled,true);
 }finally{globalThis.fetch=old;}
});
