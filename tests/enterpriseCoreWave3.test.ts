import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenAIProvider } from '../src/providers/openai.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { GeminiProvider } from '../src/providers/gemini.js';
import { DeepSeekProvider } from '../src/providers/deepseek.js';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import { applyPatch } from '../src/tools/applyPatch.js';
import { fsEdit } from '../src/tools/fsEdit.js';
import { multiEdit } from '../src/tools/multiEdit.js';
import { fsWrite } from '../src/tools/fsWrite.js';
import { fsRead } from '../src/tools/fsRead.js';
import { checkFileStaleness, clearFileTracker } from '../src/tools/fileTracker.js';
import { sysRun, isFinalCommandSearch, cleanSubprocessOutput, resolvePortableShell } from '../src/tools/sysRun.js';
import { persistentShell, cleanupPersistentShells } from '../src/tools/persistentShell.js';
import { LspSession } from '../src/lsp/lspClient.js';
import { loadCustomLspServers, matchingSpecsForFile, findLocalOrPathExecutable } from '../src/lsp/lspCatalog.js';
import { lspCodeIntel } from '../src/tools/lspCodeIntel.js';
import { buildRepoMap, clearRepoMapCache } from '../src/codebase/repoMap.js';
import { codeSearchAst } from '../src/tools/codeSearchAst.js';
import { codeSearcher } from '../src/tools/codeSearcher.js';
import { loadWorkspaceIgnoreMatcher, clearIgnoreRulesCache } from '../src/ignoreRules.js';
import { fsSearch } from '../src/tools/fsSearch.js';
import { selfRepairToolCall } from '../src/tools/toolSelfRepair.js';
import { validateAndNormalizeToolArgs } from '../src/agent/toolArgValidator.js';
import { fsMove } from '../src/tools/fsMove.js';
import { AgentLoop } from '../src/agentLoop.js';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-w3-')));

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

describe('Wave 3 — Paid BYOK Parity, Core Editing, Execution & Code Intel', () => {
  test('OpenAIProvider uses max_completion_tokens and omits temperature for o-series and gpt-5/gpt-6 reasoning models', async () => {
    const o3 = new OpenAIProvider({ apiKey: 'test-oai-key-1234', model: 'o3-mini' });
    const gpt5 = new OpenAIProvider({ apiKey: 'test-oai-key-1234', model: 'gpt-5.4-mini' });
    const gpt5NoReason = new OpenAIProvider({ apiKey: 'test-oai-key-1234', model: 'gpt-5.4-mini', reasoningEffort: 'none' });
    const gpt4o = new OpenAIProvider({ apiKey: 'test-oai-key-1234', model: 'gpt-4o' });

    assert.equal(o3.usesMaxCompletionTokens(), true);
    assert.equal(o3.rejectsSamplingParameters(), true);
    assert.equal(gpt5.usesMaxCompletionTokens(), true);
    assert.equal(gpt5.rejectsSamplingParameters(), true);
    assert.equal(gpt5NoReason.usesMaxCompletionTokens(), true);
    assert.equal(gpt5NoReason.rejectsSamplingParameters(), false);
    assert.equal(gpt4o.usesMaxCompletionTokens(), false);
    assert.equal(gpt4o.rejectsSamplingParameters(), false);

    const origFetch = globalThis.fetch;
    let capturedBody: any = null;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body || '{}'));
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 }
        })
      } as unknown as Response;
    }) as typeof fetch;

    try {
      await gpt5.chat([{ role: 'user', content: 'hi' }], { maxTokens: 1024, temperature: 0.2 });
      assert.equal(capturedBody.max_completion_tokens, 1024);
      assert.equal(capturedBody.max_tokens, undefined);
      assert.equal(capturedBody.temperature, undefined);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('AnthropicProvider restricts tool search to Claude 4.5+/5, defaults to 5m cache, adds rolling history breakpoint, merges assistant turns, and preserves thinking_blocks', async () => {
    const claude35 = new AnthropicProvider({ apiKey: 'ant-test-key-1234', model: 'claude-3-5-sonnet' });
    const claude46 = new AnthropicProvider({ apiKey: 'ant-test-key-1234', model: 'claude-sonnet-4-6' });
    assert.equal(claude35.supportsToolSearch(), false);
    assert.equal(claude46.supportsToolSearch(), true);
    assert.equal(claude46.cacheTtl, '5m');

    const origFetch = globalThis.fetch;
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = (init?.headers as Record<string, string>) || {};
      capturedBody = JSON.parse(String(init?.body || '{}'));
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 100, output_tokens: 20 }
        })
      } as unknown as Response;
    }) as typeof fetch;

    try {
      const res = await claude46.chat([
        { role: 'system', content: 'sys', cacheAnchor: true },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'step 1', thinking_blocks: [{ type: 'thinking', thinking: 'hmm', signature: 'sig1' }] },
        { role: 'assistant', content: 'step 2' },
        { role: 'user', content: 'second' }
      ], { tools: [{ name: 'fs_read', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }] });

      assert.equal(capturedHeaders['anthropic-beta'], 'advanced-tool-use-2025-11-20');
      assert.equal(capturedBody.messages.length, 3, 'consecutive assistant messages must merge');
      const assistantBlocks = capturedBody.messages[1].content;
      assert.equal(assistantBlocks[0]?.type, 'thinking', 'thinking_blocks must survive on text-only assistant turn');
      assert.equal(assistantBlocks[2]?.text, 'step 2');
      assert.equal(capturedBody.messages[2].content[0]?.cache_control?.type, 'ephemeral', 'rolling user history cache breakpoint must be set');
      assert.equal(capturedBody.messages[2].content[0]?.cache_control?.ttl, undefined, 'default 5m cache omits 1h ttl');
      assert.equal(res.usage.measurement, 'provider_reported');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('Gemini merges same-role turns & deduplicates JSON-fallback thought text; DeepSeek backfills reasoner reasoning_content; OpenAICompatible normalizes bare local root URLs', async () => {
    const localCompat = new OpenAICompatibleProvider({ baseUrl: 'http://127.0.0.1:1234', model: 'qwen-local' });
    assert.equal(localCompat.baseUrl, 'http://127.0.0.1:1234/v1/chat/completions');

    const origFetch = globalThis.fetch;
    let geminiBody: any = null;
    let deepseekBody: any = null;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body || '{}'));
      if (url.includes('generativelanguage.googleapis.com')) {
        geminiBody = body;
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({
            candidates: [{
              content: {
                role: 'model',
                parts: [
                  { thought: true, text: 'Single thought.' },
                  { text: 'Final answer.' }
                ]
              }
            }],
            usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 }
          })
        } as unknown as Response;
      }
      deepseekBody = body;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'done' } }],
          usage: { prompt_tokens: 15, completion_tokens: 5 }
        })
      } as unknown as Response;
    }) as typeof fetch;

    try {
      const gemini = new GeminiProvider({ apiKey: 'gem-test-key-1234', model: 'gemini-2.5-flash' });
      const gemRes = await gemini.chat([
        { role: 'user', content: 'part 1' },
        { role: 'user', content: 'part 2' },
        { role: 'assistant', content: 'reply 1' },
        { role: 'assistant', content: 'reply 2' },
        { role: 'user', content: 'final question' }
      ], { onChunk: () => {} });
      assert.equal(geminiBody.contents.length, 3, 'consecutive same-role Gemini contents must merge');
      assert.equal(geminiBody.contents[0].parts.length, 2);
      assert.equal(geminiBody.contents[1].parts.length, 2);
      assert.equal(gemRes.reasoningContent, 'Single thought.', 'JSON-fallback thought must not double-append');

      const ds = new DeepSeekProvider({ apiKey: 'ds-test-key-1234', model: 'deepseek-reasoner' });
      await ds.chat([
        { role: 'user', content: 'run tool' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'fs_read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'tc1', content: 'ok' }
      ]);
      assert.equal(deepseekBody.messages[1].reasoning_content, '', 'deepseek-reasoner must backfill missing reasoning_content on historical tool turns');
      assert.equal(deepseekBody.temperature, undefined);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('applyPatch preserves CRLF line endings and safely executes case-only renames without data loss', async () => {
    const ws = path.join(TMP, 'patch-crlf-case');
    fs.mkdirSync(ws, { recursive: true });
    const crlfFile = path.join(ws, 'WinFile.ts');
    fs.writeFileSync(crlfFile, 'export const a = 1;\r\nexport const b = 2;\r\n', 'utf8');

    const res = await applyPatch.execute({
      patch: [
        '*** Begin Patch',
        '*** Update File: WinFile.ts',
        '*** Move to: winfile.ts',
        '@@',
        ' export const a = 1;',
        '-export const b = 2;',
        '+export const b = 42;',
        '*** End Patch'
      ].join('\n')
    }, { workspaceRoot: ws });

    assert.equal(res.success, true, res.error);
    const entries = fs.readdirSync(ws);
    assert.ok(entries.includes('winfile.ts'), `expected case-only rename target winfile.ts in [${entries.join(', ')}]`);
    const content = fs.readFileSync(path.join(ws, 'winfile.ts'), 'utf8');
    assert.equal(content, 'export const a = 1;\r\nexport const b = 42;\r\n', 'CRLF line endings must be preserved');
  });

  test('applyPatch honors @@ contextHeader, *** End of File, rejects ambiguous hunks, emits closest-line hints, and allows Delete+Add replacement', async () => {
    const ws = path.join(TMP, 'patch-anchors');
    fs.mkdirSync(ws, { recursive: true });
    const dupFile = path.join(ws, 'dups.ts');
    fs.writeFileSync(dupFile, [
      'function alpha() {',
      '  return 1;',
      '}',
      'function beta() {',
      '  return 1;',
      '}',
      ''
    ].join('\n'), 'utf8');

    // Ambiguous hunk without @@ context header must fail atomically
    const ambig = await applyPatch.execute({
      patch: [
        '*** Begin Patch',
        '*** Update File: dups.ts',
        '@@',
        '-  return 1;',
        '+  return 2;',
        '*** End Patch'
      ].join('\n')
    }, { workspaceRoot: ws });
    assert.equal(ambig.success, false);
    assert.match(ambig.error || '', /ambiguous/i);

    // Disambiguated with @@ function beta() patches ONLY beta()
    const disambig = await applyPatch.execute({
      patch: [
        '*** Begin Patch',
        '*** Update File: dups.ts',
        '@@ function beta()',
        '-  return 1;',
        '+  return 99;',
        '*** End Patch'
      ].join('\n')
    }, { workspaceRoot: ws });
    assert.equal(disambig.success, true, disambig.error);
    const updated = fs.readFileSync(dupFile, 'utf8');
    assert.match(updated, /alpha\(\) \{\n  return 1;/);
    assert.match(updated, /beta\(\) \{\n  return 99;/);

    // Mismatch emits closest-line hint
    const miss = await applyPatch.execute({
      patch: [
        '*** Begin Patch',
        '*** Update File: dups.ts',
        '@@',
        '-  return 777;',
        '+  return 888;',
        '*** End Patch'
      ].join('\n')
    }, { workspaceRoot: ws });
    assert.equal(miss.success, false);
    assert.match(miss.error || '', /Closest line/i);

    // Delete + Add of same path in one patch succeeds
    const replaceRes = await applyPatch.execute({
      patch: [
        '*** Begin Patch',
        '*** Delete File: dups.ts',
        '*** Add File: dups.ts',
        '+export const replaced = true;',
        '*** End Patch'
      ].join('\n')
    }, { workspaceRoot: ws });
    assert.equal(replaceRes.success, true, replaceRes.error);
    assert.equal(fs.readFileSync(dupFile, 'utf8'), 'export const replaced = true;\n');
  });

  test('fsEdit and MultiEdit enforce uniqueness, support replace_all, preserve CRLF/indent, and refuse unsafe fuzzy token mutation', async () => {
    const ws = path.join(TMP, 'edit-deterministic');
    fs.mkdirSync(ws, { recursive: true });
    const target = path.join(ws, 'sample.ts');
    fs.writeFileSync(target, 'const port = 3000;\r\nconst backupPort = 3000;\r\n  if (count === 1) return true;\r\n', 'utf8');

    // Ambiguous match fails without replace_all
    const ambig = await fsEdit.execute({
      path: target,
      edits: [{ searchContent: '3000', replaceContent: '8080' }]
    }, { workspaceRoot: ws });
    assert.equal(ambig.success, false);
    assert.match(ambig.error || '', /ambiguous/i);

    // Unsafe 90% Levenshtein drift (count === 2 vs count === 1) must FAIL with Closest line hint instead of silently corrupting code
    const nearMiss = await fsEdit.execute({
      path: target,
      edits: [{ searchContent: '  if (count === 2) return true;', replaceContent: '  if (count === 2) return false;' }]
    }, { workspaceRoot: ws });
    assert.equal(nearMiss.success, false);
    assert.match(nearMiss.error || '', /Closest line 3/i);

    // replace_all updates both occurrences and preserves CRLF
    const allRes = await multiEdit.execute({
      file_path: target,
      edits: [
        { old_string: '3000', new_string: '8080', replace_all: true },
        // Indent-shifted deterministic trimmed-line match preserves existing 2-space indent
        { old_string: 'if (count === 1) return true;', new_string: 'if (count === 1) return false;' }
      ]
    }, { workspaceRoot: ws });
    assert.equal(allRes.success, true, allRes.error);
    assert.equal(
      fs.readFileSync(target, 'utf8'),
      'const port = 8080;\r\nconst backupPort = 8080;\r\n  if (count === 1) return false;\r\n'
    );
  });

  test('fsWrite defaults new workspace files to readable 0o644 and fileTracker detects external edits after read', async () => {
    clearFileTracker();
    const ws = path.join(TMP, 'write-mode-tracker');
    fs.mkdirSync(ws, { recursive: true });
    const file = path.join(ws, 'hello.ts');
    const writeRes = await fsWrite.execute({ path: file, content: 'export const x = 1;\n' }, { workspaceRoot: ws });
    assert.equal(writeRes.success, true, writeRes.error);
    if (process.platform !== 'win32') {
      const mode = fs.statSync(file).mode & 0o777;
      assert.equal(mode & 0o444, 0o444, `expected world-readable 0o644 workspace file, got 0o${mode.toString(8)}`);
    }

    const readRes = await fsRead.execute({ path: file }, { workspaceRoot: ws });
    assert.equal(readRes.success, true);
    assert.equal(checkFileStaleness(file).stale, false);

    // Simulate external edit changing size & mtime
    fs.writeFileSync(file, 'export const x = 1;\nexport const y = 2;\n', 'utf8');
    const stale = checkFileStaleness(file);
    assert.equal(stale.stale, true);
    assert.match(stale.warning || '', /modified externally/i);

    const strictBlocked = await fsEdit.execute(
      { path: file, edits: [{ searchContent: 'x = 1', replaceContent: 'x = 9' }] },
      { workspaceRoot: ws, strictFreshness: true } as any
    );
    assert.equal(strictBlocked.success, false);
    assert.match(strictBlocked.error || '', /modified externally/i);
  });

  test('fsRead supports SVG text XML, lineNumbers, offset/limit, validates endLine < startLine, and stops early on huge slices', async () => {
    const ws = path.join(TMP, 'read-upgrades');
    fs.mkdirSync(ws, { recursive: true });
    const svgFile = path.join(ws, 'icon.svg');
    fs.writeFileSync(svgFile, '<svg viewBox="0 0 24 24">\n  <circle cx="12" cy="12" r="10" />\n</svg>\n', 'utf8');

    const svgRes = await fsRead.execute({ path: svgFile, lineNumbers: true }, { workspaceRoot: ws });
    assert.equal(svgRes.success, true, svgRes.error);
    assert.match(svgRes.output || '', /1\| <svg viewBox/);
    assert.match(svgRes.output || '', /2\|   <circle/);

    const sliceRes = await fsRead.execute({ path: svgFile, offset: 2, limit: 1, lineNumbers: true }, { workspaceRoot: ws });
    assert.equal(sliceRes.success, true);
    assert.match(sliceRes.output || '', /2\|   <circle/);
    assert.doesNotMatch(sliceRes.output || '', /1\| <svg/);

    const badRange = await fsRead.execute({ path: svgFile, startLine: 10, endLine: 2 }, { workspaceRoot: ws });
    assert.equal(badRange.success, false);
    assert.match(badRange.error || '', /endLine.*less than startLine/i);

    // >256KiB file early-stop slice
    const bigFile = path.join(ws, 'big.log');
    fs.writeFileSync(bigFile, Array.from({ length: 10_000 }, (_, i) => `LOG LINE ${i + 1}: ${'x'.repeat(30)}`).join('\n'), 'utf8');
    const bigSlice = await fsRead.execute({ path: bigFile, offset: 5, limit: 3 }, { workspaceRoot: ws });
    assert.equal(bigSlice.success, true);
    assert.match(bigSlice.output || '', /LOG LINE 5:/);
    assert.match(bigSlice.output || '', /more lines follow/i);
  });

  test('sysRun does not mask find exit-1 errors, redacts secrets, resolves portable shell, and preserves head+tail on >50KB output', async () => {
    assert.equal(isFinalCommandSearch('find /nonexistent -name foo'), false, 'find exit 1 is a real error, not 0 matches');
    assert.equal(isFinalCommandSearch('grep needle file.txt'), true);
    const fakeTok = 'ghp_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz123456';
    assert.equal(cleanSubprocessOutput(`token=${fakeTok}`).includes(fakeTok), false, 'subprocess output must redact secrets');

    const sh = resolvePortableShell('echo ok');
    assert.ok(sh.shell.length > 0);
    if (process.platform === 'win32') {
      assert.deepEqual(sh.shellArgs.slice(0, 3), ['/d', '/s', '/c']);
    }

    const ws = path.join(TMP, 'sysrun-head-tail');
    fs.mkdirSync(ws, { recursive: true });
    const bigRes = await sysRun.execute({
      command: `${JSON.stringify(process.execPath)} -e "console.log('HEAD_START_MARKER'); console.log('X'.repeat(65000)); console.log('TAIL_END_MARKER');"`,
      cwd: ws
    });
    assert.equal(bigRes.success, true, bigRes.error);
    assert.match(bigRes.output, /HEAD_START_MARKER/);
    assert.match(bigRes.output, /OUTPUT TRUNCATED/);
    assert.match(bigRes.output, /TAIL_END_MARKER/);
  });

  test('persistentShell completes cleanly on >256KiB stdout without dropping markerToken', async () => {
    const ws = path.join(TMP, 'pshell-large');
    fs.mkdirSync(ws, { recursive: true });
    try {
      const res = await persistentShell.execute({
        sessionId: 'w3-large-test',
        timeoutMs: 8000,
        command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('Z'.repeat(300000) + '\\n');"`
      }, { workspaceRoot: ws });
      assert.equal(res.success, true, res.error);
      const parsed = JSON.parse(res.output || '{}');
      assert.match(parsed.stdout || '', /truncated at 256 KiB/i);
    } finally {
      cleanupPersistentShells();
    }
  });

  test('LspSession answers workspace/configuration arrays, supports LSP 3.17 pull diagnostics, typeDefinition/implementation/callHierarchy, and killSync', async () => {
    const ws = path.join(TMP, 'lsp-317');
    fs.mkdirSync(ws, { recursive: true });
    const sampleFile = path.join(ws, 'mod.ts');
    fs.writeFileSync(sampleFile, 'export function greet() { return 1; }\n', 'utf8');
    const cfgReplyFile = path.join(ws, 'cfg-reply.json');
    const mockLsp = path.join(ws, 'mock-lsp.mjs');
    fs.writeFileSync(mockLsp, `
      import fs from 'node:fs';
      const encode = (obj) => {
        const body = Buffer.from(JSON.stringify(obj), 'utf8');
        return Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\\r\\n\\r\\n', 'utf8'), body]);
      };
      let buf = Buffer.alloc(0);
      process.stdin.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (true) {
          const sep = buf.indexOf('\\r\\n\\r\\n');
          if (sep === -1) break;
          const m = /Content-Length:\\s*(\\d+)/i.exec(buf.slice(0, sep).toString('utf8'));
          if (!m) break;
          const len = Number(m[1]);
          if (buf.length < sep + 4 + len) break;
          const msg = JSON.parse(buf.slice(sep + 4, sep + 4 + len).toString('utf8'));
          buf = buf.slice(sep + 4 + len);
          if (msg.method === 'initialize') {
            process.stdout.write(encode({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { diagnosticProvider: true } } }));
            process.stdout.write(encode({ jsonrpc: '2.0', id: 900, method: 'workspace/configuration', params: { items: [{ section: 'a' }, { section: 'b' }] } }));
          } else if (msg.id === 900) {
            fs.writeFileSync(${JSON.stringify(cfgReplyFile)}, JSON.stringify(msg.result));
          } else if (msg.method === 'textDocument/diagnostic') {
            process.stdout.write(encode({ jsonrpc: '2.0', id: msg.id, result: { kind: 'full', items: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, code: 'TS2322', message: 'Pulled type error' }] } }));
          } else if (msg.method === 'textDocument/typeDefinition') {
            process.stdout.write(encode({ jsonrpc: '2.0', id: msg.id, result: [{ uri: msg.params.textDocument.uri, range: { start: { line: 0, character: 7 }, end: { line: 0, character: 12 } } }] }));
          } else if (msg.method === 'textDocument/prepareCallHierarchy') {
            process.stdout.write(encode({ jsonrpc: '2.0', id: msg.id, result: [{ name: 'greet', kind: 12, uri: msg.params.textDocument.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } }, selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } } }] }));
          } else if (msg.method === 'callHierarchy/incomingCalls') {
            process.stdout.write(encode({ jsonrpc: '2.0', id: msg.id, result: [{ from: { name: 'main', kind: 12, uri: msg.params.item.uri, range: { start: { line: 5, character: 0 }, end: { line: 5, character: 10 } }, selectionRange: { start: { line: 5, character: 0 }, end: { line: 5, character: 4 } } } }] }));
          } else if (msg.method === 'shutdown') {
            process.stdout.write(encode({ jsonrpc: '2.0', id: msg.id, result: null }));
          }
        }
      });
    `, 'utf8');

    const session = new LspSession({ serverId: 'mock', command: process.execPath, args: [mockLsp], workspaceRoot: ws });
    try {
      const diags = await session.getDiagnostics(sampleFile, 200);
      assert.equal(diags.length, 1);
      assert.equal(diags[0]?.message, 'Pulled type error');
      const typeDefs = await session.typeDefinition(sampleFile, 1, 1);
      assert.equal(typeDefs[0]?.line, 1);
      const callers = await session.callHierarchy(sampleFile, 1, 17, 'incoming');
      assert.equal(callers[0]?.name, 'main');
      assert.equal(callers[0]?.line, 6);
      assert.deepEqual(JSON.parse(fs.readFileSync(cfgReplyFile, 'utf8')), [null, null], 'workspace/configuration must reply with matching-length array');
    } finally {
      session.killSync();
      assert.equal(session.isAlive(), false);
    }
  });

  test('lspCatalog supports .causyne/lsp.json overrides, .venv probing, expanded languages, and lspCodeIntel exposes call hierarchy actions', () => {
    const ws = path.join(TMP, 'lsp-catalog-custom');
    const venvBin = path.join(ws, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
    fs.mkdirSync(path.join(ws, '.causyne'), { recursive: true });
    fs.mkdirSync(venvBin, { recursive: true });

    const fakePyBin = path.join(venvBin, process.platform === 'win32' ? 'basedpyright-langserver.cmd' : 'basedpyright-langserver');
    fs.writeFileSync(fakePyBin, '#!/bin/sh\nexit 0\n', 'utf8');
    if (process.platform !== 'win32') fs.chmodSync(fakePyBin, 0o755);

    assert.equal(findLocalOrPathExecutable('basedpyright-langserver', ws, { PATH: '' }), fakePyBin);

    fs.writeFileSync(path.join(ws, '.causyne', 'lsp.json'), JSON.stringify({
      servers: [{ id: 'custom-dsl', command: 'dsl-ls', args: ['--stdio'], extensions: ['.dsl'], rootMarkers: ['dsl.toml'] }]
    }), 'utf8');
    const custom = loadCustomLspServers(ws);
    assert.equal(custom.length, 1);
    assert.equal(matchingSpecsForFile('app.dsl', ws)[0]?.id, 'custom-dsl');
    assert.ok(matchingSpecsForFile('Main.java').some((s) => s.id === 'jdtls'));
    assert.ok(matchingSpecsForFile('App.vue').some((s) => s.id === 'vue-ls'));
    assert.ok(lspCodeIntel.schema.parameters.properties.action.enum.includes('incoming_calls'));
    assert.ok(lspCodeIntel.schema.parameters.properties.action.enum.includes('type_definition'));
  });

  test('buildRepoMap uses BFS traversal (never drops shallow a* files), respects .gitignore/.causyneignore, and caches parsed files', () => {
    clearRepoMapCache();
    const ws = path.join(TMP, 'repomap-bfs');
    fs.mkdirSync(path.join(ws, 'alpha'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'zeta', 'deep', 'nested'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'generated'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.gitignore'), 'generated/\n*.gen.ts\n', 'utf8');
    fs.writeFileSync(path.join(ws, 'alpha', 'core.ts'), 'export function coreAlpha() { return 1; }\n', 'utf8');
    fs.writeFileSync(path.join(ws, 'generated', 'skip.ts'), 'export const ignoredDir = true;\n', 'utf8');
    fs.writeFileSync(path.join(ws, 'alpha', 'auto.gen.ts'), 'export const ignoredGlob = true;\n', 'utf8');
    for (let i = 0; i < 15; i++) {
      fs.writeFileSync(path.join(ws, 'zeta', 'deep', 'nested', `leaf${i}.ts`), `export const leaf${i} = ${i};\n`, 'utf8');
    }

    const mapped = buildRepoMap(ws, { maxFiles: 10 });
    const rels = mapped.files.map((f) => f.relPath);
    assert.ok(rels.includes('alpha/core.ts'), `BFS must include shallow alpha/core.ts, got: ${rels.join(', ')}`);
    assert.equal(rels.some((r) => r.startsWith('generated/')), false, '.gitignore directory must be excluded');
    assert.equal(rels.includes('alpha/auto.gen.ts'), false, '.gitignore glob must be excluded');
  });

  test('buildRepoMap resolves multi-line JS/TS imports, require/dynamic import, Python relative/dotted imports, and Rust crate edges', () => {
    clearRepoMapCache();
    const ws = path.join(TMP, 'repomap-multilang');
    fs.mkdirSync(path.join(ws, 'ts'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'py', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'rs', 'src'), { recursive: true });

    fs.writeFileSync(path.join(ws, 'ts', 'hub.ts'), 'export function hubFn() {}\n', 'utf8');
    fs.writeFileSync(path.join(ws, 'ts', 'a.ts'), 'import {\n  hubFn\n} from "./hub.js";\nexport const a = hubFn;\n', 'utf8');
    fs.writeFileSync(path.join(ws, 'ts', 'b.ts'), 'const h = require("./hub");\nexport const b = h;\n', 'utf8');
    fs.writeFileSync(path.join(ws, 'ts', 'c.ts'), 'export async function c() { return import("./hub.js"); }\n', 'utf8');

    fs.writeFileSync(path.join(ws, 'py', 'pkg', 'core.py'), 'def py_core():\n    return 1\n', 'utf8');
    fs.writeFileSync(path.join(ws, 'py', 'pkg', 'worker.py'), 'from .core import py_core\ndef run():\n    return py_core()\n', 'utf8');
    fs.writeFileSync(path.join(ws, 'py', 'app.py'), 'from py.pkg.core import py_core\ndef main():\n    return py_core()\n', 'utf8');

    const map = buildRepoMap(ws, { maxFiles: 50 });
    const hubRank = map.files.find((f) => f.relPath === 'ts/hub.ts')?.rank ?? 0;
    const leafRank = map.files.find((f) => f.relPath === 'ts/a.ts')?.rank ?? 0;
    assert.ok(hubRank > leafRank, `ts/hub.ts (${hubRank}) must outrank importer ts/a.ts (${leafRank}) via multi-line/require/dynamic imports`);

    const pyCoreRank = map.files.find((f) => f.relPath === 'py/pkg/core.py')?.rank ?? 0;
    const pyWorkerRank = map.files.find((f) => f.relPath === 'py/pkg/worker.py')?.rank ?? 0;
    assert.ok(pyCoreRank > pyWorkerRank, `py/pkg/core.py (${pyCoreRank}) must outrank py/pkg/worker.py (${pyWorkerRank})`);
  });

  test('codeSearchAst parses real TypeScript AST (interfaces, types, enums, class methods) and supports multi-file directories', async () => {
    const ws = path.join(TMP, 'ts-ast-test');
    fs.mkdirSync(ws, { recursive: true });
    const tsFile = path.join(ws, 'service.ts');
    fs.writeFileSync(tsFile, [
      'export interface UserRecord { id: string; }',
      'export type UserId = string;',
      'export enum Role { Admin, Member }',
      'export class AuthService {',
      '  verifyToken(token: string): boolean { return token.length > 0; }',
      '}',
      'export const hashPin = (pin: string) => pin.trim();',
      ''
    ].join('\n'), 'utf8');

    const single = await codeSearchAst.execute({ targetFile: tsFile }, { workspaceRoot: ws });
    assert.equal(single.success, true, single.error);
    assert.match(single.output || '', /TypeScript(?:\/JS)? AST/);
    assert.match(single.output || '', /Interface: UserRecord/);
    assert.match(single.output || '', /Type: UserId/);
    assert.match(single.output || '', /Enum: Role/);
    assert.match(single.output || '', /Class: AuthService/);
    assert.match(single.output || '', /Method: AuthService\.verifyToken/);
    assert.match(single.output || '', /Arrow\/Var Function: hashPin/);

    const dirSearch = await codeSearchAst.execute({ targetFile: ws, query: 'verifyToken' }, { workspaceRoot: ws });
    assert.equal(dirSearch.success, true, dirSearch.error);
    assert.match(dirSearch.output || '', /service\.ts/);
    assert.match(dirSearch.output || '', /AuthService\.verifyToken/);
  });

  test('codeSearcher supports context lines (-A/-B/-C), files_with_matches, count mode, CRLF files, and astMode+isRegex', async () => {
    const ws = path.join(TMP, 'rg-modes');
    fs.mkdirSync(ws, { recursive: true });
    const f1 = path.join(ws, 'a.ts');
    const f2 = path.join(ws, 'b.ts');
    fs.writeFileSync(f1, 'const header = 1;\r\nexport function computeTotal() {\r\n  return 42;\r\n}\r\n', 'utf8');
    fs.writeFileSync(f2, 'export function computeDelta() { return 1; }\nexport function computeSum() { return 2; }\n', 'utf8');

    const ctxRes = await codeSearcher.execute({ query: 'computeTotal', searchPath: ws, context: 1 }, { workspaceRoot: ws });
    assert.equal(ctxRes.success, true, ctxRes.error);
    const ctxData = JSON.parse(ctxRes.output || '{}');
    assert.equal(ctxData.total_matches, 1);
    assert.ok(Array.isArray(ctxData.matches[0]?.ContextBefore), 'expected ContextBefore lines');
    assert.ok(Array.isArray(ctxData.matches[0]?.ContextAfter), 'expected ContextAfter lines');

    const filesRes = await codeSearcher.execute({ query: 'compute', searchPath: ws, outputMode: 'files_with_matches' }, { workspaceRoot: ws });
    const filesData = JSON.parse(filesRes.output || '{}');
    assert.equal(filesData.total_files, 2);

    const countRes = await codeSearcher.execute({ query: 'compute', searchPath: ws, outputMode: 'count' }, { workspaceRoot: ws });
    const countData = JSON.parse(countRes.output || '{}');
    assert.equal(countData.total_matches, 3);
    assert.equal(countData.counts.length, 2);

    const astRegexRes = await codeSearcher.execute({ query: 'compute(Total|Sum)', searchPath: ws, isRegex: true, astMode: true }, { workspaceRoot: ws });
    const astRegexData = JSON.parse(astRegexRes.output || '{}');
    assert.equal(astRegexData.total_matches, 2);
  });

  test('.causyneignore engine supports globs, directories, and !negations and blocks fsRead, fsSearch, codeSearcher, and repoMap', async () => {
    clearIgnoreRulesCache();
    clearRepoMapCache();
    const ws = path.join(TMP, 'causyneignore-ws');
    fs.mkdirSync(path.join(ws, 'private'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.causyneignore'), [
      '# Ignore secrets except public example',
      'private/',
      '*.secret.ts',
      '!keep.secret.ts',
      ''
    ].join('\n'), 'utf8');
    const blocked1 = path.join(ws, 'private', 'vault.ts');
    const blocked2 = path.join(ws, 'prod.secret.ts');
    const allowed = path.join(ws, 'keep.secret.ts');
    fs.writeFileSync(blocked1, 'export const SECRET_NEEDLE = "hidden1";\n', 'utf8');
    fs.writeFileSync(blocked2, 'export const SECRET_NEEDLE = "hidden2";\n', 'utf8');
    fs.writeFileSync(allowed, 'export const SECRET_NEEDLE = "visible";\n', 'utf8');

    const matcher = loadWorkspaceIgnoreMatcher(ws);
    assert.equal(matcher.isIgnored(blocked1), true);
    assert.equal(matcher.isIgnored(blocked2), true);
    assert.equal(matcher.isIgnored(allowed), false, '!keep.secret.ts negation must un-ignore');

    const readBlocked = await fsRead.execute({ path: blocked1 }, { workspaceRoot: ws });
    assert.equal(readBlocked.success, false);
    assert.match(readBlocked.error || '', /\.causyneignore/i);

    const readAllowed = await fsRead.execute({ path: allowed }, { workspaceRoot: ws });
    assert.equal(readAllowed.success, true);

    const searchRes = await fsSearch.execute({ query: 'SECRET_NEEDLE', path: ws }, { workspaceRoot: ws });
    assert.equal(searchRes.success, true);
    assert.match(searchRes.output || '', /keep\.secret\.ts/);
    assert.doesNotMatch(searchRes.output || '', /vault\.ts|prod\.secret\.ts/);

    const rgRes = await codeSearcher.execute({ query: 'SECRET_NEEDLE', searchPath: ws }, { workspaceRoot: ws });
    assert.equal(rgRes.success, true);
    assert.match(rgRes.output || '', /keep\.secret\.ts/);
    assert.doesNotMatch(rgRes.output || '', /vault\.ts|prod\.secret\.ts/);

    const map = buildRepoMap(ws);
    const rels = map.files.map((f) => f.relPath);
    assert.ok(rels.includes('keep.secret.ts'));
    assert.equal(rels.includes('private/vault.ts'), false);
    assert.equal(rels.includes('prod.secret.ts'), false);
  });

  test('toolSelfRepair routes V4A patch to apply_patch, toolArgValidator validates task_bg/apply_patch/fs_edit, fsMove handles case-only renames, and AgentLoop auto-compacts on context_overflow', async () => {
    const repaired = selfRepairToolCall({ name: 'patch', arguments: { patch: '*** Begin Patch\n*** End Patch' } });
    assert.equal(repaired.name, 'apply_patch');

    assert.match(validateAndNormalizeToolArgs('task_bg', { action: 'start' }) || '', /command/);
    assert.match(validateAndNormalizeToolArgs('task_bg', { action: 'stop' }) || '', /taskId/);
    assert.match(validateAndNormalizeToolArgs('apply_patch', {}) || '', /patch/);
    assert.match(validateAndNormalizeToolArgs('fs_edit', { path: 'a.ts', edits: [] }) || '', /edits/);

    const ws = path.join(TMP, 'fsmove-case-overflow');
    fs.mkdirSync(ws, { recursive: true });
    const src = path.join(ws, 'MyClass.ts');
    const dst = path.join(ws, 'myclass.ts');
    fs.writeFileSync(src, 'export class MyClass {}\n', 'utf8');
    const mvRes = await fsMove.execute({ source: src, destination: dst }, { workspaceRoot: ws });
    assert.equal(mvRes.success, true, mvRes.error);
    assert.ok(fs.readdirSync(ws).includes('myclass.ts'), 'case-only fsMove must produce exact new casing');

    // Verify AgentLoop auto-compacts and recovers from HTTP 413 context_overflow
    const loop = new AgentLoop(null, 'test-overflow', 'Summarize progress briefly.', { workspaceRoot: ws }) as any;
    loop.backoff = async () => {};
    // Seed enough prior turns so compactSessionMessages can reclaim messages
    for (let i = 0; i < 10; i++) {
      loop.messages.push({ role: 'user', content: `Prior step ${i}: ` + 'x'.repeat(500) });
      loop.messages.push({ role: 'assistant', content: `Ack ${i}: ` + 'y'.repeat(500) });
    }
    const beforeCount = loop.messages.length;
    let calls = 0;
    const model = {
      model: 'gpt-4o',
      supportsVision: false,
      chat: async () => {
        calls++;
        if (calls === 1) {
          const err: any = new Error('maximum context length exceeded');
          err.status = 413;
          throw err;
        }
        return { content: 'Recovered after auto-compaction.', usage: { promptTokens: 100, completionTokens: 10 } };
      }
    };
    loop.initializeProvider = () => model;
    loop.llm = model;
    await loop.run();
    assert.equal(calls, 2, 'loop must retry once after auto-compacting on context_overflow');
    assert.ok(loop.messages.length < beforeCount, 'messages array must be compacted on context_overflow');
  });
});
