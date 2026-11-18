import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import {gameAssetFetcher} from '../src/tools/gameAssetFetcher.js';
test('safe ordinary WAV names stay allowed after portable filename hardening',async()=>{
 const outputDir=await fs.mkdtemp(os.tmpdir()+'/causyne-safe-name-');
 try{
  const r=await gameAssetFetcher.execute({action:'synth_wav',preset:'hit',outputFilename:'fx_hit_01.wav',outputDir});
  assert.equal(r.success,true,r.error);
 }finally{await fs.rm(outputDir,{recursive:true,force:true});}
});
