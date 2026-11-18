import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gameAssetFetcher} from '../src/tools/gameAssetFetcher.js';
test('Windows-ambiguous trailing dot and space filenames are rejected',async()=>{
 for(const outputFilename of ['file.wav ','file.wav.']){
  const r=await gameAssetFetcher.execute({action:'synth_wav',preset:'hit',outputFilename});
  assert.equal(r.success,false,outputFilename);
  assert.match(r.error,/plain file name/);
 }
});
