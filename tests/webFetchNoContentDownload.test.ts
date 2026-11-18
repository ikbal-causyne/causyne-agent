import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {webFetch} from '../src/tools/webFetch.js';
test('HTTP 204 is not reported as a successfully downloaded file',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'causyne-204-'));
 const before=globalThis.fetch;
 globalThis.fetch=(async()=>new Response(null,{status:204})) as typeof fetch;
 try{
  const r=await webFetch.execute({url:'https://1.1.1.1/missing',outputFile:'out.bin'},{workspaceRoot:dir});
  assert.equal(r.success,false); assert.equal(r.status,204);
  assert.deepEqual(await fs.readdir(dir),[]);
 }finally{globalThis.fetch=before;await fs.rm(dir,{recursive:true,force:true});}
});
