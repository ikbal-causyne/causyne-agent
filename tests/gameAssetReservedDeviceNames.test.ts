import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gameAssetFetcher} from '../src/tools/gameAssetFetcher.js';
test('reserved Windows device names cannot become asset destinations',async()=>{
 for(const outputFilename of ['CON.wav','nul.wav','COM1.wav','lpt9.wav']){
  const r=await gameAssetFetcher.execute({action:'synth_wav',preset:'coin',outputFilename});
  assert.equal(r.success,false,outputFilename);
  assert.match(r.error,/plain file name/);
 }
});
