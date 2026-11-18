import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gameAssetHarvester } from '../src/tools/gameAssetHarvester.js';

test('procedural asset fallback replaces the destination atomically without partial siblings',async()=>{
  const projectDir=await fs.mkdtemp(path.join(os.tmpdir(),'causyne-fallback-atomic-'));
  const before=globalThis.fetch;
  globalThis.fetch=(async()=>new Response(null,{status:404})) as typeof fetch;
  try {
    const file=path.join(projectDir,'assets','3d','props','cube.obj');
    await fs.mkdir(path.dirname(file),{recursive:true});
    await fs.writeFile(file,'old');
    const out=await gameAssetHarvester.execute({action:'download_asset',projectDir,assetUrl:'https://1.1.1.1/cube.obj'});
    assert.equal(out.success,true);
    assert.equal(JSON.parse(out.output).downloaded,false);
    assert.match(await fs.readFile(file,'utf8'),/v -0.5/);
    assert.deepEqual(await fs.readdir(path.dirname(file)),['cube.obj']);
  } finally {globalThis.fetch=before;await fs.rm(projectDir,{recursive:true,force:true});}
});
