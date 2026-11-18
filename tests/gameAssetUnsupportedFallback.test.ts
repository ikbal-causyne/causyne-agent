import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gameAssetHarvester } from '../src/tools/gameAssetHarvester.js';

test('asset harvester cannot manufacture an OBJ placeholder with a GLTF or archive extension', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-no-fake-asset-'));
  const before = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null,{status:404})) as typeof fetch;
  try {
    for (const extension of ['gltf','glb','zip']) {
      const result = await gameAssetHarvester.execute({
        action:'download_asset',projectDir:workspace,assetUrl:`https://1.1.1.1/model.${extension}`
      });
      assert.equal(result.success,false,extension);
      await assert.rejects(fs.stat(path.join(workspace,'assets','3d','props',`model.${extension}`)),/ENOENT/);
    }
  } finally { globalThis.fetch=before; await fs.rm(workspace,{recursive:true,force:true}); }
});
