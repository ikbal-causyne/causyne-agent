import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StreamingCodePreview, NativeCodeObserver, codeProgressFromAction, renderCodeProgress } from '../src/tui/codeProgress.js';
import { CodeStreamRenderer } from '../src/tui/codeStreamRenderer.js';
import { Transcript } from '../src/tui/transcript.js';
import { stripAnsi, visibleWidth } from '../src/tui/text.js';
import { AcpProvider } from '../src/providers/acp.js';
import { AntigravityProvider } from '../src/providers/antigravity.js';
import { LocalCLIConnection } from '../src/cliMode.js';

test('model code chunks update a bounded draft and tool edits show replacement code', () => {
  const stream = new StreamingCodePreview();
  assert.equal(stream.accept('Here is code:\n```ts\nconst n', 1000)?.code, 'const n');
  assert.equal(stream.accept(' = 1;\n', 1200)?.code, 'const n = 1;\n');
  const edit = codeProgressFromAction('fs_edit', {
    path: '/tmp/app.ts', edits: [{ searchContent: 'old', replaceContent: 'const n = 2;' }]
  }, 'edit-1');
  assert.equal(edit?.description, 'Editing app.ts');
  assert.equal(edit?.code, 'const n = 2;');
  const xml = new StreamingCodePreview();
  const toolDraft = xml.accept('<tool_call>{"name":"fs_write","arguments":{"path":"app.ts","content":"const x = 1;\\n', 1000);
  assert.equal(toolDraft?.code, 'const x = 1;\n');
});

test('code panel replaces its live frame and preserves user-visible thinking as a model note', () => {
  const transcript = new Transcript();
  const renderer = new CodeStreamRenderer({ transcript });
  const start = codeProgressFromAction('fs_write', { path: 'app.ts', content: 'const a = 1;' }, 'call-1');
  assert.ok(start);
  renderer.handle(start);
  renderer.handle({ ...start, code: 'const a = 2;' });
  assert.equal(transcript.length, 1);
  renderer.handle({ type: 'agent_reasoning', content: 'Updating the answer after inspecting the file', streaming: true });
  assert.equal(transcript.length, 1);
  const visible = stripAnsi(transcript.rows(60).join('\n'));
  assert.match(visible, /model note: Updating the answer/);
  assert.match(visible, /const a = 2;/);
  renderer.handle({ ...start, phase: 'done' });
  assert.equal(transcript.length, 1);
  renderer.handle({ type: 'agent_message', content: 'Finished.' });
  assert.equal(transcript.length, 2);
  for (const width of [40, 42]) {
    for (const row of transcript.rows(width)) assert.ok(visibleWidth(row) <= width);
  }
});

test('the CLI uses the streaming renderer by default', () => {
  const connection = new LocalCLIConnection();
  assert.ok(connection.renderer instanceof CodeStreamRenderer);
});

test('rounded corners appear when Unicode terminal mode is enabled', () => {
  const script = `import {renderCodeProgress} from './src/tui/codeProgress.js';\n` +
    `console.log(renderCodeProgress({type:'code_progress',id:'a',phase:'working',operation:'Editing',description:'Editing file',source:'tool'},40)[0]);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '1', NO_COLOR: '', CAUSYNE_NO_COLOR: '0', CAUSYNE_ASCII: '0', TERM: 'xterm-256color' }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(stripAnsi(result.stdout), /╭/);
  assert.match(stripAnsi(result.stdout), /╮/);
});

test('untrusted code cannot send terminal control sequences through the panel', () => {
  const rows = renderCodeProgress({
    type: 'code_progress', id: 'x', phase: 'working', operation: 'Editing',
    description: 'Editing file', code: 'before\x1b[2Jafter', source: 'tool'
  }, 48).join('\n');
  assert.ok(!rows.includes('\x1b[2J'));
});

test('native file action previews disk changes when provider only supplies a path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-code-observer-'));
  const events: Array<{ code?: string; phase: string }> = [];
  const observer = new NativeCodeObserver(dir, event => events.push(event));
  const target = path.join(dir, 'index.html');
  const action = codeProgressFromAction('write_file', { Path: target }, 'native-1');
  assert.ok(action);
  try {
    observer.handle(action);
    fs.writeFileSync(target, '<main>first</main>');
    observer.poll('native-1');
    fs.writeFileSync(target, '<main>second</main>');
    observer.poll('native-1');
    observer.handle({ ...action, phase: 'done' });
    assert.deepEqual(events.map(event => event.code), [
      '<main>first</main>', '<main>second</main>', '<main>second</main>'
    ]);
    assert.equal(events.at(-1)?.phase, 'done');
  } finally {
    observer.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Antigravity path-only write events reach a code preview after the file changes', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-agy-code-'));
  const target = path.join(dir, 'index.html');
  const fake = path.join(dir, 'agy');
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
process.stdin.resume();
process.stdin.on('end', () => {
  const send = event => process.stdout.write(JSON.stringify(event) + '\\n');
  const action = state => send({event:'step_update',step_update:{step_type:'tool',state,tool_name:'write_file',tool_info:{name:'write_file',parameters:{Path:${JSON.stringify(target)}}}}});
  action('ACTIVE');
  fs.writeFileSync(${JSON.stringify(target)}, '<h1>Real file</h1>');
  action('DONE');
  send({event:'result',result:{status:'SUCCESS',response:'File created',usage:{input_tokens:2,output_tokens:2}}});
});
`, { mode: 0o755 });
  const events: Array<{ code?: string; phase: string }> = [];
  const observer = new NativeCodeObserver(dir, event => events.push(event));
  try {
    const provider = new AntigravityProvider({ command: fake, model: 'Gemini 3.8 Flash (Low)' });
    await provider.chat([{ role: 'user', content: 'create index.html' }], {
      onNativeAction: action => {
        const progress = codeProgressFromAction(action.name,
          action.parameters || { path: action.detail || '' }, `provider:${action.name}:${action.detail || ''}`,
          action.status === 'completed' ? 'done' : 'working', 'provider');
        if (progress) observer.handle(progress);
      }
    });
    assert.ok(events.some(event => event.code === '<h1>Real file</h1>' && event.phase === 'done'));
  } finally {
    observer.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ACP message and file action updates reach the same live callbacks', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-code-acp-'));
  const fake = path.join(dir, 'acp-peer');
  fs.writeFileSync(fake, `#!/usr/bin/env node
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    if (req.method === 'initialize') send({jsonrpc:'2.0',id:req.id,result:{protocolVersion:1,agentInfo:{name:'fake',version:'1'},agentCapabilities:{promptCapabilities:{image:false}}}});
    else if (req.method === 'session/new') send({jsonrpc:'2.0',id:req.id,result:{sessionId:'s1'}});
    else if (req.method === 'session/set_model') send({jsonrpc:'2.0',id:req.id,result:{}});
    else if (req.method === 'session/prompt') {
      const update = data => send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'s1',update:data}});
      update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'\\x60\\x60\\x60ts\\nconst a = 1;\\n'}});
      update({sessionUpdate:'tool_call',toolCallId:'edit-1',title:'Edit app.ts',kind:'edit',status:'in_progress',locations:[{path:'app.ts'}],content:[{type:'diff',path:'app.ts',newText:'const a = 2;'}]});
      update({sessionUpdate:'tool_call_update',toolCallId:'edit-1',status:'completed'});
      send({jsonrpc:'2.0',id:req.id,result:{stopReason:'end_turn'}});
    }
  }
});
`, { mode: 0o755 });
  const provider = new AcpProvider({ provider: 'acp/test-peer', command: fake, args: [] });
  const chunks: string[] = [];
  const actions: Array<{ status: string; parameters?: Record<string, unknown> }> = [];
  try {
    await provider.chat([{ role: 'user', content: 'edit app.ts' }], {
      onChunk: chunk => chunks.push(chunk),
      onNativeAction: action => actions.push(action)
    });
    assert.match(chunks.join(''), /const a = 1/);
    assert.deepEqual(actions.map(action => action.status), ['running', 'completed']);
    assert.equal(actions[1]?.parameters?.content, 'const a = 2;');
  } finally {
    await provider.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
