import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import {webFetch} from '../src/tools/webFetch.js';
test('explicit HTTP Range downloads carry partial metadata',async()=>{
 const old=globalThis.fetch;const workspaceRoot=await fs.mkdtemp(os.tmpdir()+'/causyne-range-');
 globalThis.fetch=(async()=>new Response(new Uint8Array([1,2,3]),{status:206,headers:{'content-range':'bytes 0-2/50'}})) as typeof fetch;
 try{
  const r=await webFetch.execute({url:'https://1.1.1.1/test',headers:{Range:'bytes=0-2'},outputFile:'piece.bin'},{workspaceRoot});
  assert.equal(r.success,true,r.error);assert.equal(r.partial,true);assert.match(r.output,/partial content/);
 }finally{globalThis.fetch=old;await fs.rm(workspaceRoot,{recursive:true,force:true});}
});
