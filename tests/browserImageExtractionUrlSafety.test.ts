import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {IMAGES_EXTRACT_SCRIPT} from '../src/browser/causyneBrowser.js';
test('rendered image extraction excludes unsafe protocols credentials and unbounded URLs',()=>{
 const credentialUrl = new URL('https://example.org/private');
 credentialUrl.username = 'user';
 credentialUrl.password = 'pass';
 const images=[
  {src:'javascript:alert(1)',alt:'unsafe'},
  {src:credentialUrl.href,alt:'credentials'},
  {src:'https://example.org/'+ 'a'.repeat(5000),alt:'oversized'},
  {src:'https://example.org/image.png',alt:'valid',naturalWidth:20,naturalHeight:10}
 ];
 const document={baseURI:'https://example.org/',querySelectorAll:()=>images};
 const extract=runInNewContext(IMAGES_EXTRACT_SCRIPT,{document,URL});
 const result=extract({limit:100});
 assert.deepEqual(result.map((x:any)=>x.src),['https://example.org/image.png']);
 assert.equal(result[0].alt,'valid');
});
