import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSearchResults} from '../src/tools/webSearch.js';
test('web search normalizes rendered results before exposing them to agents',()=>{
 const result=normalizeSearchResults([
  {title:'A\u001b[2JResult',url:'https://example.org/one',snippet:'info\u202e',engine:'google'},
  {title:'Private',url:'http://127.0.0.1/debug',snippet:'secret',engine:'google'},
  {title:'',url:'https://example.org/blank',snippet:'none',engine:'google'}
 ]);
 assert.equal(result.length,1);
 assert.equal(result[0].title,'A [2JResult');
 assert.equal(result[0].snippet,'info');
});
