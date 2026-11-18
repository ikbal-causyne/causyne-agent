import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WorkspacePreview} from '../src/browser/workspacePreview.js';
test('local browser previews deny token and backup-secret filenames',async()=>{
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'causyne-preview-secrets-'));
 try{
  await fs.writeFile(path.join(workspace,'index.html'),'<h1>test</h1>');
  for(const name of ['secret-backup.json','token-cache.json','private-config.json']) {
   await fs.writeFile(path.join(workspace,name),'sensitive');
  }
  await fs.writeFile(path.join(workspace,'config.json'),'public');
  const preview=new WorkspacePreview();
  const url=new URL(await preview.open(workspace,'index.html'));
  for(const name of ['secret-backup.json','token-cache.json','private-config.json']) {
   assert.equal((await preview.response(new URL(name,url).href))?.status,403,name);
  }
  assert.equal((await preview.response(new URL('config.json',url).href))?.status,200);
 }finally{await fs.rm(workspace,{recursive:true,force:true});}
});
