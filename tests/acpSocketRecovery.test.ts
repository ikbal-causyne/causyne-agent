import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpClient } from '../src/acp/client.js';
import { AcpProvider } from '../src/providers/acp.js';
import { classifyAgentError } from '../src/agent/errorClassifier.js';

const socketFailure = 'AI_APICallError: Cannot connect to API: The socket connection was closed unexpectedly.';

function fixture(mode: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-acp-socket-'));
  const script = path.join(directory, 'peer.cjs');
  fs.writeFileSync(script, `
const readline = require('node:readline');
const fs = require('node:fs');
const mode = ${JSON.stringify(mode)};
const error = ${JSON.stringify(socketFailure)};
const send = v => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\\n');
const update = (sessionId, update) => send({method:'session/update',params:{sessionId,update}});
let prompt;
readline.createInterface({input:process.stdin}).on('line', line => {
  const r = JSON.parse(line);
  if(r.method === 'initialize') send({id:r.id,result:{protocolVersion:1,agentCapabilities:{}}});
  if(r.method === 'session/new') send({id:r.id,result:{sessionId:'socket-test'}});
  if(r.method === 'session/set_model') {
    if(mode === 'late-model') setTimeout(() => send({id:r.id,result:{}}), 250);
    else if(mode !== 'silent-model') send({id:r.id,result:{}});
  }
  if(r.method === 'session/prompt') {
    prompt = r.id;
    fs.appendFileSync('prompts.txt', 'prompt\\n');
    if(mode === 'recover') {
      process.stderr.write(error+'\\n');
      setTimeout(() => {
        update('socket-test',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Recovered successfully.'}});
        send({id:prompt,result:{stopReason:'end_turn'}});
      }, 1800);
    } else if(mode === 'malformed') {
      process.stdout.write('null\\n[]\\n{}\\nnot-json\\n');
      send({jsonrpc:'1.0',method:'session/update',params:{sessionId:'socket-test',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'invalid version'}}}});
      update('socket-test',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Valid after malformed frames.'}});
      send({id:prompt,result:{stopReason:'end_turn'}});
    } else if(mode === 'silent-model' || mode === 'late-model') {
      setTimeout(() => {
        update('socket-test',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Valid after model timeout.'}});
        send({id:prompt,result:{stopReason:'end_turn'}});
      }, 350);
    } else if(mode === 'missing-reason') {
      send({id:prompt,result:{}});
    } else if(mode === 'unknown-reason') {
      send({id:prompt,result:{stopReason:'unknown'}});
    } else if(mode === 'action-status') {
      update('socket-test',{sessionUpdate:'tool_call',toolCallId:'edit',kind:'edit',title:'Edit',status:'in_progress',rawInput:{path:'index.html'}});
      update('socket-test',{sessionUpdate:'tool_call_update',toolCallId:'edit',status:'completed'});
      update('socket-test',{sessionUpdate:'tool_call_update',toolCallId:'edit',status:'in_progress'});
      update('socket-test',{sessionUpdate:'tool_call',toolCallId:'cancelled',kind:'edit',status:'cancelled',rawInput:{path:'other.html'}});
      update('socket-test',{sessionUpdate:'tool_call',toolCallId:123,kind:'edit',status:'completed',rawInput:{path:'invalid.html'}});
      update('socket-test',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Reported results.'}});
      send({id:prompt,result:{stopReason:'end_turn'}});
    } else if(mode === 'empty') {
      send({id:prompt,result:{stopReason:'end_turn'}});
    } else if(mode === 'malformed-chunk') {
      update('socket-test',{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:{bad:true}}});
      update('socket-test',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:12345}});
      update('socket-test',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Valid text.'}});
      send({id:prompt,result:{stopReason:'end_turn'}});
    } else if(mode === 'final-exit') {
      update('socket-test',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Final response.'}});
      send({id:prompt,result:{stopReason:'end_turn'}});
      process.stdout.write('', () => process.exit(0));
    } else if(mode === 'oversize') {
      update('socket-test',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'x'.repeat(200001)}});
      send({id:prompt,result:{stopReason:'end_turn'}});
    } else if(mode === 'large-reasoning') {
      update('socket-test',{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'x'.repeat(210000)}});
      update('socket-test',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Done.'}});
      send({id:prompt,result:{stopReason:'end_turn'}});
    } else if(mode === 'refusal') {
      send({id:prompt,result:{stopReason:'refusal'}});
    } else if(mode === 'silent') {
      // Stay alive until the host cancels or shuts down the peer.
    } else if(mode === 'fragmented') {
      const frame = JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'socket-test',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Fragmented response.'}}}})+'\\n';
      process.stdout.write(frame.slice(0, 22));
      setTimeout(() => { process.stdout.write(frame.slice(22)); send({id:prompt,result:{stopReason:'end_turn'}}); }, 20);
    } else if(mode === 'foreign-permission') {
      send({id:'foreign-permission',method:'session/request_permission',params:{sessionId:'another-session',toolCall:{toolCallId:'foreign',kind:'execute',title:'foreign operation'},options:[{optionId:'allow',kind:'allow_once',name:'Allow'}]}});
    } else if(mode === 'foreign') {
      update('another-session',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Foreign update'}});
      update('socket-test',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Correct session'}});
      send({id:prompt,result:{stopReason:'end_turn'}});
    } else {
      update('socket-test',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Partial progress.'}});
      update('socket-test',{sessionUpdate:'tool_call',toolCallId:'edit-1',kind:'edit',title:'Edit',status:'completed',rawInput:{path:'index.html'}});
      send({id:prompt,error:{code:-32000,message:error}});
    }
  }
  if(r.id === 'foreign-permission' && r.result) {
    update('socket-test',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(r.result.outcome)}});
    send({id:prompt,result:{stopReason:'end_turn'}});
  }
  if(r.method === 'session/cancel') {
    fs.appendFileSync('cancels.txt','cancel\\n');
    send({id:prompt,result:{stopReason:'cancelled'}});
  }
});
`);
  return { directory, script, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test('socket disconnects are network failures, but partial ACP turns are not replayable', () => {
  for (const message of [socketFailure, 'socket hang up', 'connection lost']) {
    assert.equal(classifyAgentError(new Error(message)), 'network_error');
  }
  assert.equal(classifyAgentError(Object.assign(new Error(socketFailure), { code: 'ACP_PARTIAL_TURN' })), 'fatal');
});

test('diagnostic monitor distinguishes recoverable stderr from terminal credentials failures', () => {
  const client = new AcpClient({ command: 'opencode', cwd: process.cwd() });
  (client as any).stderrTail = socketFailure;
  assert.equal(client.inspectPeerDiagnostics('test', Date.now(), true), null);
  assert.match(client.inspectPeerDiagnostics('test') || '', /socket connection was closed/);
  (client as any).stderrTail = 'AI_APICallError: invalid api key';
  assert.match(client.inspectPeerDiagnostics('test', Date.now(), true) || '', /invalid api key/);
});

test('real ACP subprocess is allowed to recover past the diagnostic poll', async () => {
  const f = fixture('recover');
  const client = new AcpClient({ command: process.execPath, args: [f.script], cwd: f.directory, inactivityTimeoutMs: 5000, promptTimeoutMs: 10000 });
  try {
    await client.start();
    const session = await client.newSession(f.directory);
    const result = await client.prompt(session, 'Continue the task');
    assert.equal(result.text, 'Recovered successfully.');
    assert.equal(fs.existsSync(path.join(f.directory, 'cancels.txt')), false);
    assert.equal(fs.readFileSync(path.join(f.directory, 'prompts.txt'), 'utf8'), 'prompt\n');
  } finally {
    await client.close();
    f.cleanup();
  }
});

test('peer failure after progress does not respawn and replay a native edit', async () => {
  const f = fixture('partial');
  const provider = new AcpProvider({ provider: 'acp/test-peer', command: process.execPath, args: [f.script] });
  const chunks: string[] = [];
  try {
    await assert.rejects(provider.chat([{ role: 'user', content: 'Edit index.html' }], {
      workspaceRoot: f.directory, onChunk: chunk => chunks.push(chunk)
    }), { code: 'ACP_PARTIAL_TURN', completedNativeActions: 1 });
    assert.equal(chunks.join(''), 'Partial progress.');
    assert.equal(fs.readFileSync(path.join(f.directory, 'prompts.txt'), 'utf8'), 'prompt\n');
  } finally {
    await provider.close();
    f.cleanup();
  }
});

test('foreign session updates cannot contaminate the active ACP response', async () => {
  const f = fixture('foreign');
  const provider = new AcpProvider({ provider: 'acp/test-peer', command: process.execPath, args: [f.script] });
  const chunks: string[] = [];
  try {
    const result = await provider.chat([{ role: 'user', content: 'Inspect' }], {
      workspaceRoot: f.directory, onChunk: chunk => chunks.push(chunk)
    });
    assert.equal(result.content, 'Correct session');
    assert.equal(chunks.join(''), 'Correct session');
  } finally {
    await provider.close();
    f.cleanup();
  }
});

test("malformed protocol frames cannot terminate a healthy prompt", async () => {
  const f = fixture("malformed");
  const client = new AcpClient({ command: process.execPath, args: [f.script], cwd: f.directory, inactivityTimeoutMs: 5000, promptTimeoutMs: 10000 });
  try {
    await client.start();
    const session = await client.newSession(f.directory);
    const result = await client.prompt(session, 'test');
    assert.equal(result.text, 'Valid after malformed frames.');
  } finally {
    await client.close();
    f.cleanup();
  }
});

test("fragmented JSON-RPC lines reassemble without lost output", async () => {
  const f = fixture("fragmented");
  const client = new AcpClient({ command: process.execPath, args: [f.script], cwd: f.directory, inactivityTimeoutMs: 5000, promptTimeoutMs: 10000 });
  try {
    await client.start();
    const session = await client.newSession(f.directory);
    const result = await client.prompt(session, 'test');
    assert.equal(result.text, 'Fragmented response.');
  } finally {
    await client.close();
    f.cleanup();
  }
});

test("missing prompt stop reason is rejected", async () => {
  const f = fixture("missing-reason");
  const client = new AcpClient({ command: process.execPath, args: [f.script], cwd: f.directory, inactivityTimeoutMs: 5000, promptTimeoutMs: 10000 });
  try {
    await client.start();
    const session = await client.newSession(f.directory);
    await assert.rejects(client.prompt(session, 'test'), /invalid prompt stop reason/);
  } finally {
    await client.close();
    f.cleanup();
  }
});

test("unknown prompt stop reason is rejected", async () => {
  const f = fixture("unknown-reason");
  const client = new AcpClient({ command: process.execPath, args: [f.script], cwd: f.directory, inactivityTimeoutMs: 5000, promptTimeoutMs: 10000 });
  try {
    await client.start();
    const session = await client.newSession(f.directory);
    await assert.rejects(client.prompt(session, 'test'), /invalid prompt stop reason/);
  } finally {
    await client.close();
    f.cleanup();
  }
});

test("overlapping client prompts cannot steal the active stream", async () => {
  const f = fixture("recover");
  const client = new AcpClient({ command: process.execPath, args: [f.script], cwd: f.directory, inactivityTimeoutMs: 5000, promptTimeoutMs: 10000 });
  try {
    await client.start();
    const session = await client.newSession(f.directory);
    const first = client.prompt(session, 'first');
    await assert.rejects(client.prompt(session, 'second'), /already has an active prompt/);
    assert.equal((await first).text, 'Recovered successfully.');
    assert.equal(fs.readFileSync(path.join(f.directory, 'prompts.txt'), 'utf8'), 'prompt\n');
  } finally {
    await client.close();
    f.cleanup();
  }
});

test("aborted prompts never dispatch work", async () => {
  const f = fixture("silent");
  const client = new AcpClient({ command: process.execPath, args: [f.script], cwd: f.directory, inactivityTimeoutMs: 5000, promptTimeoutMs: 10000 });
  try {
    await client.start();
    const session = await client.newSession(f.directory);
    const control = new AbortController();
    control.abort();
    await assert.rejects(client.prompt(session, 'test', control.signal), { name: 'AbortError' });
    assert.equal(fs.existsSync(path.join(f.directory, 'prompts.txt')), false);
  } finally {
    await client.close();
    f.cleanup();
  }
});

test("a rejected prompt releases the active prompt lock", async () => {
  const f = fixture("missing-reason");
  const client = new AcpClient({ command: process.execPath, args: [f.script], cwd: f.directory, inactivityTimeoutMs: 5000, promptTimeoutMs: 10000 });
  try {
    await client.start();
    const session = await client.newSession(f.directory);
    await assert.rejects(client.prompt(session, 'first'), /invalid prompt stop reason/);
    await assert.rejects(client.prompt(session, 'second'), /invalid prompt stop reason/);
    assert.equal(fs.readFileSync(path.join(f.directory, 'prompts.txt'), 'utf8'), 'prompt\nprompt\n');
  } finally {
    await client.close();
    f.cleanup();
  }
});

test("prompt deadline cancels the active peer operation", async () => {
  const f = fixture("silent");
  const client = new AcpClient({ command: process.execPath, args: [f.script], cwd: f.directory, inactivityTimeoutMs: 5000, promptTimeoutMs: 500 });
  try {
    await client.start();
    const session = await client.newSession(f.directory);
    await assert.rejects(client.prompt(session, 'test'), /timed out/);
    const cancelFile = path.join(f.directory, 'cancels.txt');
    let cancelText = '';
    for (let i = 0; i < 60; i++) {
      if (fs.existsSync(cancelFile)) {
        cancelText = fs.readFileSync(cancelFile, 'utf8');
        if (cancelText.includes('cancel\n')) break;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(cancelText, 'cancel\n');
  } finally {
    await client.close();
    f.cleanup();
  }
});

test("refused peer turns remain incomplete", async () => {
  const f = fixture("refusal");
  const provider = new AcpProvider({ provider: 'acp/test-peer', command: process.execPath, args: [f.script] });
  try {
    const result = await provider.chat([{ role: 'user', content: 'test' }], { workspaceRoot: f.directory });
    assert.equal(result.incompleteTurn, true);
  } finally {
    await provider.close();
    f.cleanup();
  }
});

test("foreign session permissions never invoke host approval", async () => {
  const f = fixture("foreign-permission");
  const provider = new AcpProvider({ provider: 'acp/test-peer', command: process.execPath, args: [f.script] });
  try {
    let approvals = 0;
    const result = await provider.chat([{ role: 'user', content: 'test' }], {
      workspaceRoot: f.directory, onPeerPermission: async () => { approvals++; return { outcome: 'selected', optionId: 'allow' }; }
    });
    assert.equal(approvals, 0);
    assert.match(result.content, /"outcome":"cancelled"/);
  } finally {
    await provider.close();
    f.cleanup();
  }
});

test("overlapping provider chats do not overwrite the original turn", async () => {
  const f = fixture("recover");
  const provider = new AcpProvider({ provider: 'acp/test-peer', command: process.execPath, args: [f.script] });
  try {
    const first = provider.chat([{ role: 'user', content: 'first' }], { workspaceRoot: f.directory });
    await assert.rejects(provider.chat([{ role: 'user', content: 'second' }], { workspaceRoot: f.directory }), /already has an active chat/);
    assert.equal((await first).content, 'Recovered successfully.');
  } finally {
    await provider.close();
    f.cleanup();
  }
});

test("pre-aborted provider calls do not permanently lock the instance", async () => {
  const f = fixture("refusal");
  const provider = new AcpProvider({ provider: 'acp/test-peer', command: process.execPath, args: [f.script] });
  try {
    const control = new AbortController();
    control.abort();
    await assert.rejects(provider.chat([{ role: 'user', content: 'test' }], { workspaceRoot: f.directory, signal: control.signal }), { name: 'AbortError' });
    const result = await provider.chat([{ role: 'user', content: 'retry' }], { workspaceRoot: f.directory });
    assert.equal(result.incompleteTurn, true);
  } finally {
    await provider.close();
    f.cleanup();
  }
});

test("empty peer end-turn cannot be interpreted as successful task completion", async () => {
  const f = fixture("empty");
  const provider = new AcpProvider({ provider: 'acp/test-peer', command: process.execPath, args: [f.script] });
  try {
    const result = await provider.chat([{ role: 'user', content: 'test' }], { workspaceRoot: f.directory });
    assert.equal(result.content, '');
    assert.equal(result.incompleteTurn, true);
  } finally {
    await provider.close();
    f.cleanup();
  }
});

test("peer text and thought chunks with invalid payload types are ignored", async () => {
  const f = fixture("malformed-chunk");
  const provider = new AcpProvider({ provider: 'acp/test-peer', command: process.execPath, args: [f.script] });
  try {
    const chunks: string[] = [];
    const thoughts: string[] = [];
    const result = await provider.chat([{ role: 'user', content: 'test' }], { workspaceRoot: f.directory, onChunk: chunk => chunks.push(chunk), onReasoningChunk: chunk => thoughts.push(chunk) });
    assert.equal(result.content, 'Valid text.');
    assert.deepEqual(chunks, ['Valid text.']);
    assert.deepEqual(thoughts, []);
  } finally {
    await provider.close();
    f.cleanup();
  }
});

test("oversized peer text is interrupted without replaying the prompt", async () => {
  const f = fixture("oversize");
  const provider = new AcpProvider({ provider: 'acp/test-peer', command: process.execPath, args: [f.script] });
  try {
    await assert.rejects(provider.chat([{ role: 'user', content: 'test' }], { workspaceRoot: f.directory }), { code: 'ACP_PARTIAL_TURN' });
    assert.equal(fs.readFileSync(path.join(f.directory, 'prompts.txt'), 'utf8'), 'prompt\n');
  } finally {
    await provider.close();
    f.cleanup();
  }
});

test("reasoning accumulation is bounded while valid final text remains available", async () => {
  const f = fixture("large-reasoning");
  const provider = new AcpProvider({ provider: 'acp/test-peer', command: process.execPath, args: [f.script] });
  try {
    const thoughts: string[] = [];
    const result = await provider.chat([{ role: 'user', content: 'test' }], { workspaceRoot: f.directory, onReasoningChunk: chunk => thoughts.push(chunk) });
    assert.equal(result.content, 'Done.');
    assert.equal(result.reasoningContent?.length, 200000);
    assert.equal(thoughts.join('').length, 200000);
  } finally {
    await provider.close();
    f.cleanup();
  }
});

test("interruption evidence carries observed prose and counts without tool replay", async () => {
  const f = fixture("partial");
  const provider = new AcpProvider({ provider: 'acp/test-peer', command: process.execPath, args: [f.script] });
  try {
    await assert.rejects(provider.chat([{ role: 'user', content: 'test' }], { workspaceRoot: f.directory }), { code: 'ACP_PARTIAL_TURN', completedNativeActions: 1, unfinishedNativeActions: 0, partialText: 'Partial progress.' });
    assert.equal(fs.readFileSync(path.join(f.directory, 'prompts.txt'), 'utf8'), 'prompt\n');
  } finally {
    await provider.close();
    f.cleanup();
  }
});

test("flushed final response is retained when the peer exits immediately", async () => {
  const f = fixture("final-exit");
  const client = new AcpClient({ command: process.execPath, args: [f.script], cwd: f.directory, inactivityTimeoutMs: 5000, promptTimeoutMs: 10000 });
  try {
    await client.start();
    const session = await client.newSession(f.directory);
    const response = await client.prompt(session, 'test');
    assert.equal(response.text, 'Final response.');
    assert.equal(response.stopReason, 'end_turn');
  } finally {
    await client.close();
    f.cleanup();
  }
});

test("inactivity timeout sends cancellation and quarantines the peer", async () => {
  const f = fixture("silent");
  const client = new AcpClient({ command: process.execPath, args: [f.script], cwd: f.directory, inactivityTimeoutMs: 200, promptTimeoutMs: 10000 });
  try {
    await client.start();
    const session = await client.newSession(f.directory);
    await assert.rejects(client.prompt(session, 'test'), /stalled/);
    const cancelFile = path.join(f.directory, 'cancels.txt');
    let cancelText = '';
    for (let i = 0; i < 60; i++) {
      if (fs.existsSync(cancelFile)) {
        cancelText = fs.readFileSync(cancelFile, 'utf8');
        if (cancelText.includes('cancel\n')) break;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(cancelText, 'cancel\n');
    await assert.rejects(client.prompt(session, 'another prompt'), /stalled; peer must reconnect/);
    assert.equal(fs.readFileSync(path.join(f.directory, 'prompts.txt'), 'utf8'), 'prompt\n');
  } finally {
    await client.close();
    f.cleanup();
  }
});

test("hard deadline cannot be followed by a new prompt on the failed transport", async () => {
  const f = fixture("silent");
  const client = new AcpClient({ command: process.execPath, args: [f.script], cwd: f.directory, inactivityTimeoutMs: 5000, promptTimeoutMs: 500 });
  try {
    await client.start();
    const session = await client.newSession(f.directory);
    await assert.rejects(client.prompt(session, 'test'), /timed out/);
    await assert.rejects(client.prompt(session, 'another prompt'), /timed out; peer must reconnect/);
    assert.equal(fs.readFileSync(path.join(f.directory, 'prompts.txt'), 'utf8'), 'prompt\n');
  } finally {
    await client.close();
    f.cleanup();
  }
});

test("aborted active prompt cannot contaminate a subsequent prompt", async () => {
  const f = fixture("silent");
  const client = new AcpClient({ command: process.execPath, args: [f.script], cwd: f.directory, inactivityTimeoutMs: 5000, promptTimeoutMs: 10000 });
  try {
    await client.start();
    const session = await client.newSession(f.directory);
    const controller = new AbortController();
    const first = client.prompt(session, 'test', controller.signal);
    const promptFile = path.join(f.directory, 'prompts.txt');
    for (let i = 0; i < 50 && !fs.existsSync(promptFile); i++) await new Promise(resolve => setTimeout(resolve, 20));
    controller.abort();
    await assert.rejects(first, { name: 'AbortError' });
    await assert.rejects(client.prompt(session, 'another prompt'), { name: 'AbortError' });
    assert.equal(fs.readFileSync(promptFile, 'utf8'), 'prompt\n');
  } finally {
    await client.close();
    f.cleanup();
  }
});

test("completed native action remains completed after a stale running update", async () => {
  const f = fixture('action-status');
  const provider = new AcpProvider({ provider: 'acp/test-peer', command: process.execPath, args: [f.script] });
  try {
    const result = await provider.chat([{ role: 'user', content: 'test' }], { workspaceRoot: f.directory });
    assert.equal(result.externalActions?.find(action => action.id === 'acp:edit')?.status, 'completed');
  } finally {
    await provider.close();
    f.cleanup();
  }
});

test("cancelled native action is not reported as still running", async () => {
  const f = fixture('action-status');
  const provider = new AcpProvider({ provider: 'acp/test-peer', command: process.execPath, args: [f.script] });
  try {
    const result = await provider.chat([{ role: 'user', content: 'test' }], { workspaceRoot: f.directory });
    assert.equal(result.externalActions?.find(action => action.id === 'acp:cancelled')?.status, 'failed');
  } finally {
    await provider.close();
    f.cleanup();
  }
});

test("malformed native action ID cannot become an apparent completed action", async () => {
  const f = fixture('action-status');
  const provider = new AcpProvider({ provider: 'acp/test-peer', command: process.execPath, args: [f.script] });
  try {
    const result = await provider.chat([{ role: 'user', content: 'test' }], { workspaceRoot: f.directory });
    assert.equal(result.externalActions?.some(action => action.id === 'acp:123'), false);
    assert.equal(result.externalActions?.length, 2);
  } finally {
    await provider.close();
    f.cleanup();
  }
});

test("optional model negotiation timeout does not quarantine an otherwise usable peer", async () => {
  const f = fixture("silent-model");
  const client = new AcpClient({ command: process.execPath, args: [f.script], cwd: f.directory, promptTimeoutMs: 5000 });
  try {
    await client.start();
    const session = await client.newSession(f.directory);
    await assert.rejects((client as any).request('session/set_model', { sessionId: session, modelId: 'test' }, 50), /timed out/);
    const result = await client.prompt(session, 'test');
    assert.equal(result.stopReason, 'end_turn');
  } finally {
    await client.close();
    f.cleanup();
  }
});

test("late optional model response cannot settle a subsequent prompt", async () => {
  const f = fixture("late-model");
  const client = new AcpClient({ command: process.execPath, args: [f.script], cwd: f.directory, promptTimeoutMs: 5000 });
  try {
    await client.start();
    const session = await client.newSession(f.directory);
    await assert.rejects((client as any).request('session/set_model', { sessionId: session, modelId: 'test' }, 50), /timed out/);
    const result = await client.prompt(session, 'test');
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.text, 'Valid after model timeout.');
  } finally {
    await client.close();
    f.cleanup();
  }
});
