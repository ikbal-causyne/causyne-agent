import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StreamingCodePreview, NativeCodeObserver, codeProgressFromAction, codePreviewLineCount, renderCodeProgress } from '../src/tui/codeProgress.js';
import { CodeStreamRenderer } from '../src/tui/codeStreamRenderer.js';
import { ChatPrompt } from '../src/tui/prompt.js';
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
  assert.equal(edit?.before, 'old');
  const xml = new StreamingCodePreview();
  const toolDraft = xml.accept('<tool_call>{"name":"fs_write","arguments":{"path":"app.ts","content":"const x = 1;\\n', 1000);
  assert.equal(toolDraft?.code, 'const x = 1;\n');
});

test('code preview marks new, removed, and unchanged lines from an evidenced edit', () => {
  const edit = codeProgressFromAction('fs_edit', {
    path: 'app.ts', oldText: 'keep\nremove', newText: 'keep\nadd'
  }, 'diff-1');
  assert.ok(edit);
  const visible = stripAnsi(renderCodeProgress(edit, 50).join('\n'));
  assert.match(visible, /  keep/);
  assert.match(visible, /- remove/);
  assert.match(visible, /\+ add/);
  assert.equal(codePreviewLineCount(edit), 3);
  const longBefore = Array.from({ length: 750 }, (_, index) => `line ${index + 1}`);
  const longAfter = [...longBefore];
  longAfter[700] = 'replaced line';
  const longEdit = { ...edit, before: longBefore.join('\n'), code: longAfter.join('\n') };
  assert.equal(codePreviewLineCount(longEdit), 751);
  const longPanel = stripAnsi(renderCodeProgress(longEdit, 50, '', 695).join('\n'));
  assert.match(longPanel, /- line 701/);
  assert.match(longPanel, /\+ replaced line/);
  const removal = codeProgressFromAction('fs_edit', {
    path: 'app.ts', oldText: 'obsolete()', newText: ''
  }, 'remove-line');
  assert.ok(removal);
  assert.match(stripAnsi(renderCodeProgress(removal, 50).join('\n')), /- obsolete\(\)/);
  const unknownBefore = { ...edit, before: undefined };
  assert.doesNotMatch(stripAnsi(renderCodeProgress(unknownBefore, 50).join('\n')), /\+ add/);
  assert.doesNotMatch(stripAnsi(renderCodeProgress(unknownBefore, 50).join('\n')), /- remove/);
});

test('truecolor code preview uses soft distinct backgrounds, with clean plain-text markers', () => {
  const script = `import {renderCodeProgress} from './src/tui/codeProgress.js';\n` +
    `const event={type:'code_progress',id:'edit',phase:'working',operation:'Editing',description:'Editing file',before:'old',code:'new',source:'tool'};\n` +
    `console.log(renderCodeProgress(event,40).join('\\n'));`;
  const colored = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '3', NO_COLOR: '', CAUSYNE_NO_COLOR: '0' }
  });
  assert.equal(colored.status, 0, colored.stderr);
  assert.match(colored.stdout, /\x1b\[48;2;47;32;34m/);
  assert.match(colored.stdout, /\x1b\[48;2;32;42;32m/);
  const plain = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
  });
  assert.equal(plain.status, 0, plain.stderr);
  assert.doesNotMatch(plain.stdout, /\x1b/);
  assert.match(plain.stdout, /- old/);
  assert.match(plain.stdout, /\+ new/);
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

test('wheel over a long code panel reveals earlier lines and does not scroll the chat', () => {
  const transcript = new Transcript();
  const renderer = new CodeStreamRenderer({ transcript });
  const code = Array.from({ length: 40 }, (_, index) => `line-${index + 1}`).join('\n');
  const start = codeProgressFromAction('write_file', { path: 'app.ts', content: code }, 'long-file');
  assert.ok(start);
  renderer.handle(start);
  const viewport = { viewWidth: 80, viewHeight: 20, scrollTop: 0, wheelCalls: 0,
    wheel() { this.wheelCalls++; } };
  const surface = { out: { rows: 40 }, stage: { height: 30 }, viewport };
  const prompt = { surface, renderer, notice: '', draw() {} };
  const overPanel = { name: 'wheel', wheel: { direction: 'up', x: 5, y: 15 } };
  assert.match(stripAnsi(transcript.rows(80).join('\n')), /line-40/);
  assert.equal(ChatPrompt.prototype.handleScrollKey.call(prompt, overPanel), true);
  assert.equal(viewport.wheelCalls, 0);
  let visible = stripAnsi(transcript.rows(80).join('\n'));
  assert.match(visible, /line-28/);
  assert.doesNotMatch(visible, /line-40/);

  renderer.handle({ ...start, code: `${code}\nline-41` });
  visible = stripAnsi(transcript.rows(80).join('\n'));
  assert.match(visible, /line-28/);
  assert.doesNotMatch(visible, /line-41/);

  const down = { name: 'wheel', wheel: { direction: 'down', x: 5, y: 15 } };
  for (let i = 0; i < 10; i++) ChatPrompt.prototype.handleScrollKey.call(prompt, down);
  assert.match(stripAnsi(transcript.rows(80).join('\n')), /line-41/);
  const priorScrolls = viewport.wheelCalls;
  ChatPrompt.prototype.handleScrollKey.call(prompt, { name: 'wheel', wheel: { direction: 'up', x: 100, y: 15 } });
  assert.equal(viewport.wheelCalls, priorScrolls + 1);
});

test('code panel can reach the beginning of code beyond the former preview limit', () => {
  const content = Array.from({ length: 500 }, (_, index) => `line-${index + 1} ${'x'.repeat(30)}`).join('\n');
  const event = codeProgressFromAction('write_file', { path: 'large.ts', content }, 'large-file');
  assert.equal(event?.code, content);
  assert.ok(event);
  assert.match(stripAnsi(renderCodeProgress(event, 80, '', 0).join('\n')), /line-1 /);
  assert.match(stripAnsi(renderCodeProgress(event, 80).join('\n')), /line-500 /);
  const draft = new StreamingCodePreview();
  assert.equal(draft.accept(`\x60\x60\x60ts\n${content}`, 1000)?.code, content);
});

test('the CLI uses the streaming renderer by default', () => {
  const connection = new LocalCLIConnection();
  assert.ok(connection.renderer instanceof CodeStreamRenderer);
});

test('rounded corners appear when Unicode terminal mode is enabled', () => {
  const script = `import {renderCodeProgress} from './src/tui/codeProgress.js';\n` +
    `console.log(renderCodeProgress({type:'code_progress',id:'a',phase:'working',operation:'Editing',description:'Editing file',source:'tool'},40)[0]);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, WT_SESSION: '1', FORCE_COLOR: '1', NO_COLOR: '', CAUSYNE_NO_COLOR: '0', CAUSYNE_ASCII: '0', TERM: 'xterm-256color' }
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

test('created files exceeding 600 lines always retain green add highlights and never degrade to neutral ctx', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-code-large-create-'));
  const target = path.join(dir, 'index.html');
  fs.writeFileSync(target, '<p>old small draft</p>');

  const events: Array<any> = [];
  const observer = new NativeCodeObserver(dir, event => events.push(event));
  const action = codeProgressFromAction('write_file', { Path: target }, 'create-large');
  assert.ok(action);

  try {
    observer.handle(action);
    const new720Lines = Array.from({ length: 720 }, (_, i) => `<div class="pillar-${i}">Pillar ${i}</div>`).join('\n');
    fs.writeFileSync(target, new720Lines);
    observer.poll('create-large');
    observer.handle({ ...action, phase: 'done' });

    const doneEvent = events.at(-1);
    assert.ok(doneEvent);
    assert.equal(doneEvent.operation, 'Creating');
    assert.equal(doneEvent.before, undefined);

    const rendered = renderCodeProgress(doneEvent, 80, '', 220);
    const renderedText = stripAnsi(rendered.join('\n'));
    assert.match(renderedText, /\+ <div class="pillar-220">/);
    assert.match(renderedText, /\+ <div class="pillar-229">/);
    assert.doesNotMatch(renderedText, /  <div class="pillar-220">/);

    const sampleEvent = {
      type: 'code_progress',
      id: 'create-sample',
      phase: 'done',
      operation: 'Creating',
      description: 'Creating sample',
      code: '<div class="pillar">Pillar</div>',
      source: 'tool'
    };
    const script = `import {renderCodeProgress} from './src/tui/codeProgress.js';\n` +
      `const event = ${JSON.stringify(sampleEvent)};\n` +
      `console.log(renderCodeProgress(event, 80, '', 0).join('\\n'));`;
    const colored = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '3', NO_COLOR: '', CAUSYNE_NO_COLOR: '0' }
    });
    assert.equal(colored.status, 0, colored.stderr);
    assert.match(colored.stdout, /\x1b\[48;2;32;42;32m/);
  } finally {
    observer.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('replace_file_content and multi_replace_file_content extract TargetContent and display red deletions and green additions', () => {
  const single = codeProgressFromAction('replace_file_content', {
    TargetFile: 'app.ts',
    TargetContent: 'const oldVal = 10;',
    ReplacementContent: 'const newVal = 20;'
  }, 'edit-replace');
  assert.ok(single);
  assert.equal(single.operation, 'Editing');
  assert.equal(single.before, 'const oldVal = 10;');
  assert.equal(single.code, 'const newVal = 20;');

  const renderedSingle = renderCodeProgress(single, 80);
  const textSingle = stripAnsi(renderedSingle.join('\n'));
  assert.match(textSingle, /- const oldVal = 10;/);
  assert.match(textSingle, /\+ const newVal = 20;/);

  const multi = codeProgressFromAction('multi_replace_file_content', {
    TargetFile: 'app.ts',
    ReplacementChunks: [
      { TargetContent: 'let a = 1;', ReplacementContent: 'let a = 2;' },
      { TargetContent: 'let b = 10;', ReplacementContent: 'let b = 20;' }
    ]
  }, 'edit-multi');
  assert.ok(multi);
  assert.equal(multi.operation, 'Editing');
  assert.equal(multi.before, 'let a = 1;\nlet b = 10;');
  assert.equal(multi.code, 'let a = 2;\nlet b = 20;');

  const renderedMulti = renderCodeProgress(multi, 80);
  const textMulti = stripAnsi(renderedMulti.join('\n'));
  assert.match(textMulti, /- let a = 1;/);
  assert.match(textMulti, /\+ let a = 2;/);
});

test('large edits exceeding MAX_SIDE_LINES maintain additions and deletions without turning into ctx', () => {
  const hugeOld = Array.from({ length: 700 }, (_, i) => `old line ${i}`).join('\n');
  const hugeNew = Array.from({ length: 700 }, (_, i) => `new line ${i}`).join('\n');
  const edit = codeProgressFromAction('fs_edit', {
    path: 'huge.ts',
    oldText: hugeOld,
    newText: hugeNew
  }, 'huge-edit');
  assert.ok(edit);

  const rendered = renderCodeProgress(edit, 80, '', 650);
  const text = stripAnsi(rendered.join('\n'));
  assert.match(text, /[+-]/);
  assert.doesNotMatch(text, /  old line/);
});
