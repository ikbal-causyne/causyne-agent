import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gameAssetFetcher} from '../src/tools/gameAssetFetcher.js';
test('download and synthesizer filenames reject portable traversal and Windows alternate streams',async()=>{
 for(const outputFilename of ['dir\\\\file.wav','x:name.wav','a?b.wav','evil|file.wav','part/asset.wav']){
  const r=await gameAssetFetcher.execute({action:'synth_wav',preset:'hit',outputFilename});
  assert.equal(r.success,false,outputFilename);
  assert.match(r.error,/plain file name/);
 }
});
