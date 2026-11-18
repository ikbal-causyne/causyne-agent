import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gameAssetHarvester } from '../src/tools/gameAssetHarvester.js';
test('harvester rejects unrecognized starter packs instead of silently installing racer assets', async () => {
  const projectDir=await fs.mkdtemp(path.join(os.tmpdir(),'causyne-pack-kind-'));
  try {
    const result=await gameAssetHarvester.execute({action:'harvest_starter_pack',projectDir,packType:'unknown'});
    assert.equal(result.success,false);
    assert.match(result.error,/Unknown starter pack/);
    assert.deepEqual(await fs.readdir(projectDir),[]);
  } finally {await fs.rm(projectDir,{recursive:true,force:true});}
});
