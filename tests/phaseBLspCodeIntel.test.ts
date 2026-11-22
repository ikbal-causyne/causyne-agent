import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  encodeLspMessage,
  filePathToUri,
  LspMessageParser,
  uriToFilePath
} from '../src/lsp/lspProtocol.js';
import {
  detectInstalledLspServers,
  languageIdForFile,
  matchingSpecsForFile
} from '../src/lsp/lspCatalog.js';
import {
  formatDiagnosticsCompact,
  LspSession,
  lspSessionManager
} from '../src/lsp/lspClient.js';
import { formatLspStatusReport, lspCodeIntel } from '../src/tools/lspCodeIntel.js';
import { runCommand } from '../src/commands.js';

const TMP_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-phaseb-lsp-')));

after(async () => {
  await lspSessionManager.shutdownAll();
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch { /* ignore */ }
});

function createMockLspServerScript(dir: string): string {
  const scriptPath = path.join(dir, 'mock-lsp-server.mjs');
  fs.writeFileSync(scriptPath, `
import { fileURLToPath, pathToFileURL } from 'node:url';

let buf = Buffer.alloc(0);
const SEP = Buffer.from('\\r\\n\\r\\n', 'ascii');
const docs = new Map();

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const head = Buffer.from('Content-Length: ' + body.length + '\\r\\n\\r\\n', 'ascii');
  process.stdout.write(Buffer.concat([head, body]));
}

function publishDiags(uri, text) {
  const diagnostics = [];
  const lines = String(text || '').split('\\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('TYPE_ERROR')) {
      diagnostics.push({
        range: { start: { line: i, character: 0 }, end: { line: i, character: lines[i].length } },
        severity: 1,
        code: 'TS2322',
        source: 'mock-ts',
        message: 'Type string is not assignable to number'
      });
    }
  }
  send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } });
}

function handle(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { textDocumentSync: 1, hoverProvider: true, definitionProvider: true, referencesProvider: true, documentSymbolProvider: true, workspaceSymbolProvider: true } } });
    return;
  }
  if (msg.method === 'textDocument/didOpen') {
    const td = msg.params.textDocument;
    docs.set(td.uri, td.text);
    publishDiags(td.uri, td.text);
    return;
  }
  if (msg.method === 'textDocument/didChange') {
    const uri = msg.params.textDocument.uri;
    const text = msg.params.contentChanges?.[0]?.text ?? '';
    docs.set(uri, text);
    publishDiags(uri, text);
    return;
  }
  if (msg.method === 'textDocument/definition') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: [{ uri: msg.params.textDocument.uri, range: { start: { line: 0, character: 16 }, end: { line: 0, character: 23 } } }]
    });
    return;
  }
  if (msg.method === 'textDocument/references') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: [
        { uri: msg.params.textDocument.uri, range: { start: { line: 0, character: 16 }, end: { line: 0, character: 23 } } },
        { uri: msg.params.textDocument.uri, range: { start: { line: 2, character: 10 }, end: { line: 2, character: 17 } } }
      ]
    });
    return;
  }
  if (msg.method === 'textDocument/hover') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { contents: { kind: 'markdown', value: 'function compute(x: number): number' } }
    });
    return;
  }
  if (msg.method === 'textDocument/documentSymbol') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: [
        { name: 'compute', kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 1, character: 1 } }, selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 23 } } }
      ]
    });
    return;
  }
  if (msg.method === 'workspace/symbol') {
    const firstUri = [...docs.keys()][0] || pathToFileURL(process.cwd() + '/sample.ts').href;
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: [
        { name: 'compute', kind: 12, location: { uri: firstUri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } } } }
      ]
    });
    return;
  }
  if (msg.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: msg.id, result: null });
    return;
  }
  if (msg.method === 'exit') {
    process.exit(0);
  }
}

process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length > 0) {
    const sep = buf.indexOf(SEP);
    if (sep === -1) break;
    const head = buf.subarray(0, sep).toString('ascii');
    const match = /content-length:\\s{0,16}(\\d{1,10})/i.exec(head);
    if (!match) break;
    const len = Number.parseInt(match[1], 10);
    const start = sep + 4;
    if (buf.length < start + len) break;
    const body = buf.subarray(start, start + len).toString('utf8');
    buf = buf.subarray(start + len);
    try { handle(JSON.parse(body)); } catch {}
  }
});
`, 'utf8');
  return scriptPath;
}

describe('Phase B1 — Native LSP Code Intelligence', () => {
  test('LspMessageParser handles split chunks, multi-byte UTF-8, and strips prototype-pollution keys', () => {
    const parser = new LspMessageParser();
    const frame1 = encodeLspMessage({ jsonrpc: '2.0', id: 1, result: { label: 'λ-calculus 🚀' } });
    const maliciousJson = '{"jsonrpc":"2.0","id":2,"result":{"__proto__":{"polluted":true},"ok":1}}';
    const frame2 = Buffer.concat([
      Buffer.from(`Content-Length: ${Buffer.byteLength(maliciousJson, 'utf8')}\r\n\r\n`, 'ascii'),
      Buffer.from(maliciousJson, 'utf8')
    ]);
    const combined = Buffer.concat([frame1, frame2]);

    // Split mid-header and mid-UTF-8 body
    const out1 = parser.feed(combined.subarray(0, 12));
    assert.equal(out1.length, 0);
    const out2 = parser.feed(combined.subarray(12, frame1.length - 3));
    assert.equal(out2.length, 0);
    const out3 = parser.feed(combined.subarray(frame1.length - 3));
    assert.equal(out3.length, 2);
    assert.equal((out3[0]?.result as any).label, 'λ-calculus 🚀');
    assert.equal(({} as any).polluted, undefined);
    assert.equal(Object.hasOwn(out3[1]?.result as object, '__proto__'), false);
    assert.equal((out3[1]?.result as any).ok, 1);

    const samplePath = path.join(TMP_ROOT, 'roundtrip.ts');
    assert.equal(uriToFilePath(filePathToUri(samplePath)), path.resolve(samplePath));
  });

  test('LspMessageParser rejects missing/invalid Content-Length framing cleanly', () => {
    const parser = new LspMessageParser();
    assert.throws(() => parser.feed(Buffer.from('X-Bad: 1\r\n\r\n{}', 'ascii')), /Content-Length/);
  });

  test('lspCatalog maps extensions and probes installed servers safely', () => {
    assert.equal(languageIdForFile('src/app.ts'), 'typescript');
    assert.equal(languageIdForFile('main.py'), 'python');
    assert.equal(languageIdForFile('lib.rs'), 'rust');
    assert.equal(matchingSpecsForFile('app.ts')[0]?.id, 'typescript');

    const detected = detectInstalledLspServers(TMP_ROOT, { PATH: '' });
    assert.ok(detected.length >= 6);
    assert.equal(detected.every((d) => d.available === false), true);
  });

  test('LspSession performs full live JSON-RPC handshake, diagnostics, definition, references, hover, and symbols', async () => {
    const ws = path.join(TMP_ROOT, 'mock-lsp-ws');
    fs.mkdirSync(ws, { recursive: true });
    const mockServer = createMockLspServerScript(ws);
    const sampleFile = path.join(ws, 'sample.ts');
    fs.writeFileSync(sampleFile, 'export function compute(x: number) {\n  const bad: number = TYPE_ERROR;\n  return compute(x);\n}\n', 'utf8');

    const session = new LspSession({
      serverId: 'mock-ts',
      command: process.execPath,
      args: [mockServer],
      workspaceRoot: ws,
      timeoutMs: 5000
    });

    try {
      const diags = await session.getDiagnostics(sampleFile, 1200);
      assert.equal(diags.length, 1);
      assert.equal(diags[0]?.severity, 'error');
      assert.equal(diags[0]?.code, 'TS2322');
      assert.equal(diags[0]?.line, 2);

      const compact = formatDiagnosticsCompact(diags, ws);
      assert.match(compact, /sample\.ts:2:1 \[error TS2322\]/);

      const defs = await session.definition(sampleFile, 3, 12);
      assert.equal(defs.length, 1);
      assert.equal(defs[0]?.line, 1);

      const refs = await session.references(sampleFile, 1, 17);
      assert.equal(refs.length, 2);

      const hover = await session.hover(sampleFile, 1, 17);
      assert.match(hover, /function compute\(x: number\): number/);

      const docSymbols = await session.documentSymbols(sampleFile);
      assert.equal(docSymbols[0]?.name, 'compute');
      assert.equal(docSymbols[0]?.kind, 'Function');

      const wsSymbols = await session.workspaceSymbols('compute');
      assert.equal(wsSymbols[0]?.name, 'compute');

      // Fixing the error clears diagnostics via didChange
      fs.writeFileSync(sampleFile, 'export function compute(x: number) {\n  return x + 1;\n}\n', 'utf8');
      const cleared = await session.getDiagnostics(sampleFile, 1200);
      assert.equal(cleared.length, 0);
    } finally {
      await session.shutdown();
    }
  });

  test('code.lsp tool and /lsp command report honest server status and reject path escapes', async () => {
    const statusRes = await lspCodeIntel.execute({ action: 'status' }, { workspaceRoot: TMP_ROOT });
    assert.equal(statusRes.success, true);
    assert.match(statusRes.output || '', /Language Server Protocol/);

    const slashRes = await runCommand('lsp', ['status'], { surface: 'terminal' });
    assert.equal(slashRes.ok, true);
    assert.match(slashRes.output || '', /Installed servers/);

    const escapeRes = await lspCodeIntel.execute(
      { action: 'diagnostics', path: '../outside-escape.ts' },
      { workspaceRoot: TMP_ROOT }
    );
    assert.equal(escapeRes.success, false);
    assert.match(escapeRes.error || '', /outside the authorized workspace/i);

    assert.match(formatLspStatusReport(TMP_ROOT), /Active sessions:/);
  });
});
