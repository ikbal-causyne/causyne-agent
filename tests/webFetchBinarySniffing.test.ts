import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {looksLikeBinaryContent, webFetch} from '../src/tools/webFetch.js';
test('binary signature detection catches mislabeled archives and allows normal text',()=>{
 assert.equal(looksLikeBinaryContent(Buffer.from([0x50,0x4b,3,4,1,2])),true);
 assert.equal(looksLikeBinaryContent(Buffer.from('<h1>Public article</h1>')),false);
});
test('web.fetch refuses to corrupt ZIP bytes mislabeled text/plain',async()=>{
 const old=globalThis.fetch;
 const workspaceRoot=await fs.mkdtemp(path.join(os.tmpdir(),'causyne-binary-sniff-'));
 const payload=new Uint8Array([0x50,0x4b,3,4,8,9]);
 globalThis.fetch=(async()=>new Response(payload.slice(),{headers:{'content-type':'text/plain'}})) as typeof fetch;
 try {
  const text=await webFetch.execute({url:'https://1.1.1.1/file.zip'});
  assert.equal(text.success,false);
  assert.match(text.error??'',/Binary content requires outputFile/);
  const file=await webFetch.execute({url:'https://1.1.1.1/file.zip',outputFile:'file.zip'},{workspaceRoot});
  assert.equal(file.success,true);
  assert.deepEqual(await fs.readFile(path.join(workspaceRoot,'file.zip')),Buffer.from(payload));
 }finally{globalThis.fetch=old;await fs.rm(workspaceRoot,{recursive:true,force:true});}
});
