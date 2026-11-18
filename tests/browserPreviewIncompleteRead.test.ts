import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readBoundedPreviewFile} from '../src/browser/workspacePreview.js';
test('preview rejects partially read files instead of serving truncated resources as complete',async()=>{
 let reads=0;let closed=false;
 const openFile=async()=>({
  stat:async()=>({isFile:()=>true,size:5}),
  read:async()=>({bytesRead:reads++===0?2:0}),
  close:async()=>{closed=true}
 });
 const result=await readBoundedPreviewFile('fake.js',100,openFile as any);
 assert.equal(result,null);
 assert.equal(closed,true);
});
