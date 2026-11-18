import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gameAssetFetcher } from '../src/tools/gameAssetFetcher.js';

test('sandboxed asset synthesis defaults inside the provided workspace',async()=>{
 const workspaceRoot=await fs.mkdtemp(path.join(os.tmpdir(),'causyne-asset-workspace-default-'));
 try {
  const r=await gameAssetFetcher.execute({action:'synth_wav',preset:'coin'},{
   workspaceRoot,isPathAllowed:(candidate:string)=>candidate.startsWith(workspaceRoot)
  });
  assert.equal(r.success,true,r.error);
  const output=JSON.parse(r.output);
  assert.ok(output.output_file.startsWith(workspaceRoot));
  assert.equal((await fs.readFile(output.output_file)).subarray(0,4).toString(),'RIFF');
 }finally{await fs.rm(workspaceRoot,{recursive:true,force:true});}
});
