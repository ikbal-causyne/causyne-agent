import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../src/agentLoop.js';
import { AcpProvider } from '../src/providers/acp.js';
import { saveConfig } from '../src/config.js';
import { UnifiedBudgetEnforcer } from '../src/providers/budgetEnforcer.js';
import type { RequestPermissionRequest } from '../src/acp/protocol.js';

const request = (target: string): RequestPermissionRequest => ({
  sessionId: 'session', toolCall: { toolCallId: 'write', title: 'Write the requested note', kind: 'edit', rawInput: { path: target, content: 'NATIVE' } },
  options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }]
});

function host(root: string): AgentLoop {
  saveConfig({ autonomyMode: 'C' });
  const loop = new AgentLoop({ readyState: 1, send() {} }, 'peer-capabilities', 'Write the requested note in this workspace', { workspaceRoot: root });
  loop.efficiencyBudget = new UnifiedBudgetEnforcer();
  return loop;
}

test('ACP permission decisions preserve approved capabilities and reject outside-workspace or user-denied actions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-permission-'));
  try {
    const loop = host(root);
    const target = path.join(root, 'note.txt');
    assert.deepEqual(await loop.requestPeerPermission(request(target)), { outcome: 'selected', optionId: 'once' });
    assert.deepEqual(await loop.requestPeerPermission(request(path.join(root, '..', 'outside.txt'))), { outcome: 'cancelled' });
    loop.config.autonomyMode = 'A';
    let asked = false;
    loop.waitForApproval = async () => { asked = true; return false; };
    assert.deepEqual(await loop.requestPeerPermission(request(target)), { outcome: 'cancelled' });
    assert.equal(asked, true);
    loop.abortController.abort();
    assert.deepEqual(await loop.requestPeerPermission(request(target)), { outcome: 'cancelled' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('ACP client file service preserves full text and rejects workspace escape', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-client-files-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-client-outside-'));
  try {
    const loop = host(root);
    const contents = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    await loop.executePeerFile('fs_write', 'note.txt', contents);
    assert.equal(await loop.executePeerFile('fs_read', 'note.txt'), contents);
    assert.equal(await loop.executePeerFile('fs_read', 'note.txt', undefined, { line: 900, limit: 2 }), 'line 900\nline 901');
    const escaped = path.join(outside, 'forbidden.txt');
    await assert.rejects(loop.executePeerFile('fs_write', escaped, 'forbidden'), /not authorized/);
    assert.equal(fs.existsSync(escaped), false);
    if (process.platform !== 'win32') {
      fs.symlinkSync(outside, path.join(root, 'escape'));
      await assert.rejects(loop.executePeerFile('fs_write', 'escape/forbidden.txt', 'forbidden'), /not authorized/);
      assert.deepEqual(await loop.requestPeerPermission(request(path.join(root, 'escape', 'forbidden.txt'))), { outcome: 'cancelled' });
      const move = request(path.join(root, 'note.txt'));
      move.toolCall.kind = 'move';
      move.toolCall.rawInput = { source: path.join(root, 'note.txt'), destination: path.join(root, 'escape', 'forbidden.txt') };
      assert.deepEqual(await loop.requestPeerPermission(move), { outcome: 'cancelled' });
      assert.equal(fs.existsSync(escaped), false);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('ACP transport negotiates files, forwards MCPs, and performs approved client operations through host services', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-capability-wire-'));
  const peerFile = path.join(root, 'peer.cjs');
  fs.writeFileSync(peerFile, `const fs=require('node:fs');
const readline=require('node:readline');
const send=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\\n');
let promptId;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);
 if(r.method==='initialize') { fs.writeFileSync('capabilities.json',JSON.stringify(r.params.clientCapabilities)); send({id:r.id,result:{protocolVersion:1,agentCapabilities:{}}}); }
 else if(r.method==='session/new') { fs.writeFileSync('session.json',JSON.stringify(r.params)); send({id:r.id,result:{sessionId:'native-session'}}); }
 else if(r.method==='session/prompt') { promptId=r.id; send({id:'permission',method:'session/request_permission',params:{sessionId:'native-session',toolCall:{toolCallId:'write',title:'Write note',kind:'edit',rawInput:{path:${JSON.stringify(path.join(root, 'note.txt'))},content:'NATIVE'}},options:[{optionId:'once',kind:'allow_once',name:'Allow once'}]}}); }
 else if(r.id==='permission') { fs.writeFileSync('permission.json',JSON.stringify(r.result)); send({id:'write',method:'fs/write_text_file',params:{sessionId:'native-session',path:${JSON.stringify(path.join(root, 'note.txt'))},content:'NATIVE'}}); }
 else if(r.id==='write') { send({id:'read',method:'fs/read_text_file',params:{sessionId:'native-session',path:${JSON.stringify(path.join(root, 'note.txt'))}}}); }
 else if(r.id==='read') { send({method:'session/update',params:{sessionId:'native-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:r.result.content}}}}); send({id:promptId,result:{stopReason:'end_turn',usage:{inputTokens:20,outputTokens:3}}}); }
});`);
  const peer = new AcpProvider({ provider: 'acp/test-peer', command: process.execPath, args: [peerFile] });
  try {
    const loop = host(root);
    const mcpServers = [{ name: 'fixture', command: 'fixture-server', args: [] }];
    const response = await peer.chat([{ role: 'user', content: 'Write the note using your ACP tools' }], {
      workspaceRoot: root, peerMcpServers: mcpServers,
      onPeerPermission: req => loop.requestPeerPermission(req),
      onPeerFileRead: (file, options) => loop.executePeerFile('fs_read', file, undefined, options),
      onPeerFileWrite: async (file, content) => { await loop.executePeerFile('fs_write', file, content); }
    });
    assert.equal(response.content, 'NATIVE');
    assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'NATIVE');
    const capabilities = JSON.parse(fs.readFileSync(path.join(root, 'capabilities.json'), 'utf8'));
    assert.deepEqual(capabilities.fs, { readTextFile: true, writeTextFile: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'permission.json'), 'utf8')).outcome, { outcome: 'selected', optionId: 'once' });
    const session = JSON.parse(fs.readFileSync(path.join(root, 'session.json'), 'utf8'));
    assert.equal(fs.realpathSync(session.cwd), fs.realpathSync(root));
    assert.deepEqual(session.mcpServers, mcpServers);
  } finally { await peer.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
