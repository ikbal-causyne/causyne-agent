import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpProvider } from '../src/providers/acp.js';
import { AgentLoop } from '../src/agentLoop.js';
import type { ChatResponseAction } from '../src/providers/base.js';

const browser = { name: 'browser_act', description: 'Preview a workspace page', parameters: {
  type: 'object', properties: { actions: { type: 'array' } }, required: ['actions']
} };

function fixture(chunks: string[], waitForCancel = true, nativeRunning = false, invalidHostCall = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-acp-handoff-'));
  const script = path.join(directory, 'peer.cjs');
  fs.writeFileSync(script, `const fs = require('node:fs');
const readline = require('node:readline');
const send = v => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\\n');
let prompt, count = 0;
readline.createInterface({input:process.stdin}).on('line', line => {
 const r = JSON.parse(line);
 if(r.method === 'initialize') send({id:r.id,result:{protocolVersion:1,agentCapabilities:{}}});
 if(r.method === 'session/new') send({id:r.id,result:{sessionId:'normal-peer-session'}});
 if(r.method === 'session/set_model') send({id:r.id,result:{}});
 if(r.method === 'session/prompt') {
  prompt = r.id;
  fs.appendFileSync('prompts.jsonl', JSON.stringify(r.params)+'\\n');
  if(count++ > 0) {
   send({method:'session/update',params:{sessionId:'normal-peer-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Received actual browser result.'}}}});
   send({id:prompt,result:{stopReason:'end_turn',usage:{inputTokens:15,outputTokens:6}}}); return;
  }
  if(${nativeRunning}) send({method:'session/update',params:{sessionId:'normal-peer-session',update:{sessionUpdate:'tool_call',toolCallId:'unfinished',kind:'execute',title:'bash',status:'in_progress',rawInput:{command:'check-page'}}}});
  if(${invalidHostCall}) send({method:'session/update',params:{sessionId:'normal-peer-session',update:{sessionUpdate:'tool_call',toolCallId:'invalid-host-call',title:'invalid',status:'in_progress',rawInput:{tool:'browser_act',error:'Model tried to call unavailable tool'}}}});
  for(const text of ${JSON.stringify(chunks)}) send({method:'session/update',params:{sessionId:'normal-peer-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
  if(!${waitForCancel}) send({id:prompt,result:{stopReason:'end_turn',usage:{inputTokens:10,outputTokens:5}}});
 }
 if(r.method === 'session/cancel') {
  fs.appendFileSync('cancels.txt','cancel\\n');
  // A peer may request another native operation while cancellation drains.
  send({id:'late-permission',method:'session/request_permission',params:{sessionId:'normal-peer-session',toolCall:{toolCallId:'late',kind:'execute',title:'bash',rawInput:{command:'must-not-run'}},options:[{optionId:'once',kind:'allow_once',name:'Allow'}]}});
  send({id:prompt,result:{stopReason:'cancelled',usage:{inputTokens:10,outputTokens:5}}});
 }
});`);
  const peer = new AcpProvider({ provider: 'acp/test-peer', command: process.execPath, args: [script] });
  return { directory, peer, cleanup: async () => { await peer.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('complete streamed host request yields immediately, preserves session, and receives the real result once', async () => {
  const args = { actions: [{ type: 'preview', filePath: 'index.html' }, { type: 'snapshot' }] };
  const text = `<tool_call>${JSON.stringify({ name: 'browser_act', arguments: args })}</tool_call>`;
  const f = fixture([text.slice(0, 42), text.slice(42)]);
  let permissionCalls = 0;
  const options = { workspaceRoot: f.directory, tools: [browser], onPeerPermission: async () => {
    permissionCalls++; return { outcome: 'selected' as const, optionId: 'once' };
  } };
  const messages = [{ role: 'user', content: 'Inspect the page through the host browser.' }];
  try {
    const first = await f.peer.chat(messages, options);
    assert.equal(first.toolCalls?.length, 1);
    assert.equal(first.toolCalls?.[0]?.function.name, 'browser_act');
    assert.deepEqual(JSON.parse(first.toolCalls![0]!.function.arguments), args);
    assert.equal(first.content, '');
    assert.equal(fs.readFileSync(path.join(f.directory, 'cancels.txt'), 'utf8'), 'cancel\n');
    assert.equal(permissionCalls, 0, 'late native permission must wait until the host result is returned');
    const second = await f.peer.chat([...messages,
      { role: 'assistant', content: '', tool_calls: first.toolCalls },
      { role: 'tool', content: 'RENDER_CONFIRMED', name: 'browser_act' }
    ], options);
    assert.equal(second.content, 'Received actual browser result.');
    const prompts = fs.readFileSync(path.join(f.directory, 'prompts.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(prompts.length, 2);
    assert.equal(prompts[1].sessionId, prompts[0].sessionId);
    assert.match(JSON.stringify(prompts[1]), /RENDER_CONFIRMED/);
    assert.doesNotMatch(JSON.stringify(prompts[1]), /<tool_call>/);
  } finally { await f.cleanup(); }
});

test('stream handoff requires complete JSON and an advertised host contract', async () => {
  for (const text of [
    '<tool_call>{"name":"browser_act","arguments":{"actions":[]}',
    '<tool_call>{"name":"browser_act","arguments":{"actions":[]}</tool_call>',
    '<tool_call>{"name":"unadvertised","arguments":{}}</tool_call>'
  ]) {
    const f = fixture([text], false);
    try {
      await f.peer.chat([{ role: 'user', content: 'Inspect' }], { workspaceRoot: f.directory, tools: [browser] });
      assert.equal(fs.existsSync(path.join(f.directory, 'cancels.txt')), false);
    } finally { await f.cleanup(); }
  }
});

test('closing markup inside a JSON string cannot truncate or change a host request', async () => {
  const args = { actions: [{ type: 'preview', filePath: 'literal </tool_call> file.html' }] };
  const f = fixture([`<tool_call>${JSON.stringify({ name: 'browser_act', arguments: args })}</tool_call>`]);
  try {
    const response = await f.peer.chat([{ role: 'user', content: 'Inspect' }], { workspaceRoot: f.directory, tools: [browser] });
    assert.deepEqual(JSON.parse(response.toolCalls![0]!.function.arguments), args);
  } finally { await f.cleanup(); }
});

test('a peer ending with a running action does not fabricate successful execution', async () => {
  const f = fixture(['Still inspecting.'], false, true);
  const actions: ChatResponseAction[] = [];
  try {
    const response = await f.peer.chat([{ role: 'user', content: 'Inspect' }], {
      workspaceRoot: f.directory, onNativeAction: action => actions.push(action)
    });
    assert.equal(response.externalActions?.[0]?.status, 'running');
    assert.equal(response.incompleteTurn, true);
    assert.equal(actions.some(action => action.status === 'completed'), false);
  } finally { await f.cleanup(); }
});

test('an unavailable native call to an advertised host tool yields a routing error instead of retrying internally', async () => {
  const f = fixture([], true, false, true);
  try {
    const response = await f.peer.chat([{ role: 'user', content: 'Inspect the page.' }], { workspaceRoot: f.directory, tools: [browser] });
    assert.equal(response.toolRoutingError?.tool, 'browser_act');
    assert.equal(response.externalActions?.length || 0, 0);
    assert.equal(response.toolCalls?.length || 0, 0, 'no arguments or execution may be invented from the error');
    assert.equal(fs.readFileSync(path.join(f.directory, 'cancels.txt'), 'utf8'), 'cancel\n');
  } finally { await f.cleanup(); }
});

test('user abort remains an abort and cannot be converted into a host handoff', async () => {
  const f = fixture([]);
  const control = new AbortController();
  control.abort();
  try {
    await assert.rejects(f.peer.chat([{ role: 'user', content: 'Inspect' }], {
      workspaceRoot: f.directory, tools: [browser], signal: control.signal
    }), { name: 'AbortError' });
    assert.equal(fs.existsSync(path.join(f.directory, 'prompts.jsonl')), false);
  } finally { await f.cleanup(); }
});

test('generic peer permission wrappers retain the tracked operation kind and host scope checks', async () => {
  const f = fixture([]);
  const target = path.join(f.directory, 'index.html');
  fs.writeFileSync(target, '<h1>Scoped read</h1>');
  fs.writeFileSync(path.join(f.directory, 'peer.cjs'), `const readline=require('node:readline');
const send=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\\n');
let prompt;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);
 if(r.method==='initialize') send({id:r.id,result:{protocolVersion:1,agentCapabilities:{}}});
 if(r.method==='session/new') send({id:r.id,result:{sessionId:'wrapped'}});
 if(r.method==='session/set_model') send({id:r.id,result:{}});
 if(r.method==='session/prompt') {
  prompt=r.id;
  send({method:'session/update',params:{sessionId:'wrapped',update:{sessionUpdate:'tool_call',toolCallId:'known-read',title:'Read file',kind:'read',status:'in_progress',rawInput:{filePath:${JSON.stringify(target)}}}}});
  send({id:'wrapped-permission',method:'session/request_permission',params:{sessionId:'wrapped',toolCall:{toolCallId:'known-read',title:'Directory access',kind:'other',rawInput:{filepath:${JSON.stringify(target)}}},options:[{optionId:'once',kind:'allow_once',name:'Allow'}]}});
 }
 if(r.id==='wrapped-permission') {
  send({method:'session/update',params:{sessionId:'wrapped',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(r.result)}}}});
  send({id:prompt,result:{stopReason:'end_turn'}});
 }
});`);
  const loop = new AgentLoop({ readyState: 1, send() {} }, 'wrapped-permission-test', 'Read index.html', { workspaceRoot: f.directory });
  loop.config.autonomyMode = 'C';
  let asks = 0;
  loop.waitForApproval = async () => { asks++; return false; };
  let receivedKind: string | undefined;
  try {
    const response = await f.peer.chat([{ role: 'user', content: 'Read index.html' }], {
      workspaceRoot: f.directory,
      onPeerPermission: request => { receivedKind = request.toolCall.kind; return loop.requestPeerPermission(request); }
    });
    assert.equal(receivedKind, 'read');
    assert.match(response.content, /"outcome":"selected"/);
    assert.equal(asks, 0);
  } finally { await f.cleanup(); }
});

test('approval waits settle on cancellation and remove their pending entry', async () => {
  const loop = new AgentLoop({ readyState: 1, send() {} }, 'approval-cancel-test', 'Inspect');
  const waiting = loop.waitForApproval('cancelled-approval');
  assert.equal(loop.pendingApprovals.size, 1);
  loop.abort();
  assert.equal(await waiting, false);
  assert.equal(loop.pendingApprovals.size, 0);
});
