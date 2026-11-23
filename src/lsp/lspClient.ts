/**
 * Causyne Agent — Native LSP Client & Session Manager (Phase B1)
 *
 * Maintains workspace-scoped JSON-RPC 2.0 Language Server processes over stdio
 * with clean lifecycle management, bounded diagnostics caches, request timeouts,
 * and fail-open post-edit diagnostic collection.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sanitizeSubprocessEnv } from '../tools/subprocessEnv.js';
import { safeDisplay } from '../tui/text.js';
import {
  encodeLspMessage,
  filePathToUri,
  LspMessageParser,
  uriToFilePath,
  type LspRpcMessage
} from './lspProtocol.js';
import {
  findWorkspaceRootForLsp,
  languageIdForFile,
  resolveLspServerForFile
} from './lspCatalog.js';

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  code?: string | undefined;
  source?: string | undefined;
  message: string;
}

export interface LspLocationResult {
  file: string;
  line: number;
  column: number;
  endLine?: number | undefined;
  endColumn?: number | undefined;
}

export interface LspSymbolResult {
  name: string;
  kind: string;
  file: string;
  line: number;
  column: number;
  containerName?: string | undefined;
}

export interface LspSessionStartOptions {
  serverId: string;
  command: string;
  args: readonly string[];
  workspaceRoot: string;
  timeoutMs?: number | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_DIAGNOSTICS_PER_FILE = 200;
const MAX_SESSIONS = 6;
const MAX_FILE_SYNC_BYTES = 2 * 1024 * 1024;

const SYMBOL_KIND_NAMES: Readonly<Record<number, string>> = Object.freeze({
  1: 'File', 2: 'Module', 3: 'Namespace', 4: 'Package', 5: 'Class',
  6: 'Method', 7: 'Property', 8: 'Field', 9: 'Constructor', 10: 'Enum',
  11: 'Interface', 12: 'Function', 13: 'Variable', 14: 'Constant', 15: 'String',
  16: 'Number', 17: 'Boolean', 18: 'Array', 19: 'Object', 20: 'Key',
  21: 'Null', 22: 'EnumMember', 23: 'Struct', 24: 'Event', 25: 'Operator',
  26: 'TypeParameter'
});

function mapSeverity(code: unknown): 'error' | 'warning' | 'info' | 'hint' {
  switch (Number(code)) {
    case 1: return 'error';
    case 2: return 'warning';
    case 3: return 'info';
    default: return 'hint';
  }
}

function normalizeLocations(raw: unknown): LspLocationResult[] {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const results: LspLocationResult[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    // Supports both Location ({ uri, range }) and LocationLink ({ targetUri, targetSelectionRange | targetRange })
    const uri = typeof obj.uri === 'string'
      ? obj.uri
      : (typeof obj.targetUri === 'string' ? obj.targetUri : '');
    const range = (obj.range ?? obj.targetSelectionRange ?? obj.targetRange) as LspRange | undefined;
    if (!uri || !range?.start) continue;
    results.push({
      file: uriToFilePath(uri),
      line: Math.max(1, Number(range.start.line ?? 0) + 1),
      column: Math.max(1, Number(range.start.character ?? 0) + 1),
      ...(range.end ? {
        endLine: Math.max(1, Number(range.end.line ?? 0) + 1),
        endColumn: Math.max(1, Number(range.end.character ?? 0) + 1)
      } : {})
    });
    if (results.length >= 100) break;
  }
  return results;
}

function extractHoverText(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const contents = (raw as { contents?: unknown }).contents;
  const parts: string[] = [];
  const pushItem = (item: unknown): void => {
    if (typeof item === 'string') {
      parts.push(item);
    } else if (item && typeof item === 'object') {
      const obj = item as { value?: unknown; language?: unknown };
      if (typeof obj.value === 'string') {
        parts.push(obj.value);
      }
    }
  };
  if (Array.isArray(contents)) {
    for (const item of contents) pushItem(item);
  } else {
    pushItem(contents);
  }
  return safeDisplay(parts.join('\n').trim()).slice(0, 4000);
}

function flattenDocumentSymbols(
  raw: unknown,
  defaultFile: string,
  containerName?: string,
  out: LspSymbolResult[] = []
): LspSymbolResult[] {
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (out.length >= 200) break;
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? safeDisplay(obj.name) : '';
    if (!name) continue;
    const kind = SYMBOL_KIND_NAMES[Number(obj.kind)] ?? 'Symbol';

    // SymbolInformation shape has `location`
    const location = obj.location as { uri?: string; range?: LspRange } | undefined;
    const range = (obj.selectionRange ?? obj.range ?? location?.range) as LspRange | undefined;
    const file = typeof location?.uri === 'string' ? uriToFilePath(location.uri) : defaultFile;
    const line = Math.max(1, Number(range?.start?.line ?? 0) + 1);
    const column = Math.max(1, Number(range?.start?.character ?? 0) + 1);
    const owner = typeof obj.containerName === 'string' ? safeDisplay(obj.containerName) : containerName;

    out.push({
      name,
      kind,
      file,
      line,
      column,
      ...(owner ? { containerName: owner } : {})
    });

    if (Array.isArray(obj.children) && obj.children.length > 0) {
      flattenDocumentSymbols(obj.children, defaultFile, name, out);
    }
  }
  return out;
}

export class LspSession {
  readonly serverId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly workspaceRoot: string;
  private readonly timeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private parser = new LspMessageParser();
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private openDocs = new Map<string, { version: number; text: string }>();
  private diagnostics = new Map<string, LspDiagnostic[]>();
  private diagnosticsSeq = new Map<string, number>();
  private diagnosticWaiters = new Map<string, Array<() => void>>();
  private initPromise: Promise<void> | null = null;
  private closed = false;
  lastUsedAt = Date.now();
  serverCapabilities: Record<string, unknown> = {};

  constructor(options: LspSessionStartOptions) {
    this.serverId = options.serverId;
    this.command = options.command;
    this.args = [...options.args];
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.env = options.env ?? process.env;
  }

  isAlive(): boolean {
    return !this.closed && this.proc !== null && this.proc.exitCode === null && !this.proc.killed;
  }

  async ensureInitialized(): Promise<void> {
    if (this.closed) throw new Error(`LSP session "${this.serverId}" has been closed.`);
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const sanitizedEnv = sanitizeSubprocessEnv(this.env);
      const proc = spawn(this.command, [...this.args], {
        cwd: this.workspaceRoot,
        env: sanitizedEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true
      });
      this.proc = proc;

      proc.stdin.on('error', () => { /* ignore broken pipe during shutdown */ });
      proc.stderr.on('data', () => { /* drain stderr to prevent pipe backpressure */ });

      proc.stdout.on('data', (chunk: Buffer) => {
        try {
          const messages = this.parser.feed(chunk);
          for (const msg of messages) {
            this.handleIncoming(msg);
          }
        } catch {
          // Malformed stream framing resets parser cleanly
        }
      });

      proc.on('error', (err: Error) => {
        this.rejectAllPending(new Error(`LSP server "${this.serverId}" process error: ${err.message}`));
        this.proc = null;
        this.initPromise = null;
      });

      proc.on('exit', (code: number | null) => {
        this.rejectAllPending(new Error(`LSP server "${this.serverId}" exited (code ${String(code)}).`));
        this.proc = null;
        this.initPromise = null;
      });

      const rootUri = filePathToUri(this.workspaceRoot);
      const initResult = await this.sendRequest('initialize', {
        processId: process.pid,
        clientInfo: { name: 'causyne-agent', version: '1.0' },
        rootUri,
        rootPath: this.workspaceRoot,
        workspaceFolders: [{ uri: rootUri, name: path.basename(this.workspaceRoot) }],
        capabilities: {
          textDocument: {
            synchronization: { didSave: true },
            definition: { linkSupport: true },
            typeDefinition: { linkSupport: true },
            implementation: { linkSupport: true },
            callHierarchy: { dynamicRegistration: false },
            references: {},
            hover: { contentFormat: ['markdown', 'plaintext'] },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            publishDiagnostics: { relatedInformation: false },
            diagnostic: { dynamicRegistration: false }
          },
          workspace: {
            workspaceFolders: true,
            configuration: true,
            symbol: {}
          }
        }
      }) as { capabilities?: Record<string, unknown> } | null;

      if (initResult && typeof initResult.capabilities === 'object' && initResult.capabilities !== null) {
        this.serverCapabilities = initResult.capabilities;
      }
      this.sendNotification('initialized', {});
    })().catch((err: unknown) => {
      this.initPromise = null;
      this.killProcess();
      throw err;
    });

    return this.initPromise;
  }

  private handleIncoming(msg: LspRpcMessage): void {
    // Response to an outgoing request
    if (msg.id !== undefined && msg.id !== null && !msg.method) {
      const numericId = typeof msg.id === 'number' ? msg.id : Number(msg.id);
      const pending = this.pending.get(numericId);
      if (!pending) return;
      this.pending.delete(numericId);
      clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new Error(safeDisplay(msg.error.message || `LSP error ${String(msg.error.code ?? '')}`)));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Server -> client request (answer protocol queries accurately so servers never stall or crash)
    if (msg.id !== undefined && msg.id !== null && typeof msg.method === 'string') {
      let result: unknown = null;
      if (msg.method === 'workspace/configuration') {
        const items = (msg.params && typeof msg.params === 'object' && Array.isArray((msg.params as { items?: unknown }).items))
          ? (msg.params as { items: unknown[] }).items
          : [];
        result = items.map(() => null);
      } else if (msg.method === 'workspace/workspaceFolders') {
        result = [{ uri: filePathToUri(this.workspaceRoot), name: path.basename(this.workspaceRoot) }];
      }
      try {
        this.writeFrame({ jsonrpc: '2.0', id: msg.id, result });
      } catch { /* ignore */ }
      return;
    }

    // Notification: textDocument/publishDiagnostics
    if (msg.method === 'textDocument/publishDiagnostics' && msg.params && typeof msg.params === 'object') {
      const params = msg.params as { uri?: unknown; diagnostics?: unknown };
      if (typeof params.uri !== 'string') return;
      const mapped = this.mapRawDiagnostics(params.uri, params.diagnostics);
      this.diagnostics.set(params.uri, mapped);
      this.diagnosticsSeq.set(params.uri, (this.diagnosticsSeq.get(params.uri) ?? 0) + 1);
      const waiters = this.diagnosticWaiters.get(params.uri);
      if (waiters && waiters.length > 0) {
        this.diagnosticWaiters.delete(params.uri);
        for (const wake of waiters) wake();
      }
    }
  }

  private mapRawDiagnostics(uri: string, rawInput: unknown): LspDiagnostic[] {
    const file = uriToFilePath(uri);
    const rawDiags = Array.isArray(rawInput) ? rawInput : [];
    const mapped: LspDiagnostic[] = [];
    for (const d of rawDiags.slice(0, MAX_DIAGNOSTICS_PER_FILE)) {
      if (!d || typeof d !== 'object') continue;
      const rec = d as {
        range?: LspRange;
        severity?: unknown;
        code?: unknown;
        source?: unknown;
        message?: unknown;
      };
      const msgText = typeof rec.message === 'string' ? safeDisplay(rec.message).replace(/\s+/g, ' ').trim() : '';
      if (!msgText) continue;
      mapped.push({
        file,
        line: Math.max(1, Number(rec.range?.start?.line ?? 0) + 1),
        column: Math.max(1, Number(rec.range?.start?.character ?? 0) + 1),
        severity: mapSeverity(rec.severity),
        ...(rec.code !== undefined && rec.code !== null ? { code: safeDisplay(String(rec.code)) } : {}),
        ...(typeof rec.source === 'string' && rec.source ? { source: safeDisplay(rec.source) } : {}),
        message: msgText.slice(0, 400)
      });
    }
    return mapped;
  }

  private writeFrame(payload: Record<string, unknown>): void {
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error(`LSP server "${this.serverId}" stdin is not writable.`);
    }
    this.proc.stdin.write(encodeLspMessage(payload));
  }

  sendNotification(method: string, params?: unknown): void {
    this.lastUsedAt = Date.now();
    this.writeFrame({
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {})
    });
  }

  sendRequest(method: string, params?: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    this.lastUsedAt = Date.now();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request "${method}" timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.writeFrame({
          jsonrpc: '2.0',
          id,
          method,
          ...(params !== undefined ? { params } : {})
        });
      } catch (err: unknown) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async syncFile(filePath: string, explicitContent?: string): Promise<string> {
    await this.ensureInitialized();
    const resolved = path.resolve(filePath);
    const uri = filePathToUri(resolved);
    let text = explicitContent;
    if (text === undefined) {
      const stat = await fs.stat(resolved);
      if (stat.size > MAX_FILE_SYNC_BYTES) {
        throw new Error(`File exceeds LSP sync size limit (${MAX_FILE_SYNC_BYTES} bytes).`);
      }
      text = await fs.readFile(resolved, 'utf8');
    }
    const existing = this.openDocs.get(uri);
    if (!existing) {
      this.openDocs.set(uri, { version: 1, text });
      this.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: languageIdForFile(resolved),
          version: 1,
          text
        }
      });
    } else if (existing.text !== text) {
      const nextVersion = existing.version + 1;
      this.openDocs.set(uri, { version: nextVersion, text });
      this.sendNotification('textDocument/didChange', {
        textDocument: { uri, version: nextVersion },
        contentChanges: [{ text }]
      });
      this.sendNotification('textDocument/didSave', {
        textDocument: { uri },
        text
      });
    }
    return uri;
  }

  async getDiagnostics(filePath: string, waitMs = 600, explicitContent?: string): Promise<LspDiagnostic[]> {
    const resolved = path.resolve(filePath);
    const targetUri = filePathToUri(resolved);
    const seqBefore = this.diagnosticsSeq.get(targetUri) ?? 0;
    const uri = await this.syncFile(filePath, explicitContent);

    // Support LSP 3.17 pull diagnostics when server advertises `diagnosticProvider`
    if (this.serverCapabilities['diagnosticProvider']) {
      try {
        const pulled = await this.sendRequest('textDocument/diagnostic', {
          textDocument: { uri }
        }, Math.min(this.timeoutMs, Math.max(1500, waitMs * 3))) as { items?: unknown } | null;
        if (pulled && Array.isArray(pulled.items)) {
          const mapped = this.mapRawDiagnostics(uri, pulled.items);
          this.diagnostics.set(uri, mapped);
          this.diagnosticsSeq.set(uri, (this.diagnosticsSeq.get(uri) ?? 0) + 1);
          return [...mapped];
        }
      } catch {
        // Fall through to push diagnostics
      }
    }

    // Only wait if a fresh push did not already arrive during syncFile()
    if (waitMs > 0 && (this.diagnosticsSeq.get(uri) ?? 0) === seqBefore) {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, Math.min(waitMs, 3000));
        timer.unref?.();
        const list = this.diagnosticWaiters.get(uri) ?? [];
        list.push(finish);
        this.diagnosticWaiters.set(uri, list);
      });
    }
    return [...(this.diagnostics.get(uri) ?? [])];
  }

  async definition(filePath: string, line1Based: number, column1Based = 1): Promise<LspLocationResult[]> {
    const uri = await this.syncFile(filePath);
    const res = await this.sendRequest('textDocument/definition', {
      textDocument: { uri },
      position: { line: Math.max(0, line1Based - 1), character: Math.max(0, column1Based - 1) }
    });
    return normalizeLocations(res);
  }

  async typeDefinition(filePath: string, line1Based: number, column1Based = 1): Promise<LspLocationResult[]> {
    const uri = await this.syncFile(filePath);
    const res = await this.sendRequest('textDocument/typeDefinition', {
      textDocument: { uri },
      position: { line: Math.max(0, line1Based - 1), character: Math.max(0, column1Based - 1) }
    });
    return normalizeLocations(res);
  }

  async implementation(filePath: string, line1Based: number, column1Based = 1): Promise<LspLocationResult[]> {
    const uri = await this.syncFile(filePath);
    const res = await this.sendRequest('textDocument/implementation', {
      textDocument: { uri },
      position: { line: Math.max(0, line1Based - 1), character: Math.max(0, column1Based - 1) }
    });
    return normalizeLocations(res);
  }

  async callHierarchy(
    filePath: string,
    line1Based: number,
    column1Based = 1,
    direction: 'incoming' | 'outgoing' = 'incoming'
  ): Promise<Array<{ name: string; kind: string; file: string; line: number; column: number }>> {
    const uri = await this.syncFile(filePath);
    const prepared = await this.sendRequest('textDocument/prepareCallHierarchy', {
      textDocument: { uri },
      position: { line: Math.max(0, line1Based - 1), character: Math.max(0, column1Based - 1) }
    });
    const items = Array.isArray(prepared) ? prepared : [];
    const rootItem = items[0];
    if (!rootItem || typeof rootItem !== 'object') return [];
    const method = direction === 'incoming' ? 'callHierarchy/incomingCalls' : 'callHierarchy/outgoingCalls';
    const rawCalls = await this.sendRequest(method, { item: rootItem });
    const list = Array.isArray(rawCalls) ? rawCalls : [];
    const out: Array<{ name: string; kind: string; file: string; line: number; column: number }> = [];
    for (const entry of list.slice(0, 60)) {
      if (!entry || typeof entry !== 'object') continue;
      const target = (direction === 'incoming'
        ? (entry as { from?: unknown }).from
        : (entry as { to?: unknown }).to) as Record<string, unknown> | undefined;
      if (!target || typeof target !== 'object') continue;
      const targetUri = typeof target.uri === 'string' ? target.uri : '';
      const range = (target.selectionRange ?? target.range) as LspRange | undefined;
      const name = typeof target.name === 'string' ? safeDisplay(target.name) : '';
      if (!targetUri || !name) continue;
      out.push({
        name,
        kind: SYMBOL_KIND_NAMES[Number(target.kind)] ?? 'Symbol',
        file: uriToFilePath(targetUri),
        line: Math.max(1, Number(range?.start?.line ?? 0) + 1),
        column: Math.max(1, Number(range?.start?.character ?? 0) + 1)
      });
    }
    return out;
  }

  async references(
    filePath: string,
    line1Based: number,
    column1Based = 1,
    includeDeclaration = true
  ): Promise<LspLocationResult[]> {
    const uri = await this.syncFile(filePath);
    const res = await this.sendRequest('textDocument/references', {
      textDocument: { uri },
      position: { line: Math.max(0, line1Based - 1), character: Math.max(0, column1Based - 1) },
      context: { includeDeclaration }
    });
    return normalizeLocations(res);
  }

  async hover(filePath: string, line1Based: number, column1Based = 1): Promise<string> {
    const uri = await this.syncFile(filePath);
    const res = await this.sendRequest('textDocument/hover', {
      textDocument: { uri },
      position: { line: Math.max(0, line1Based - 1), character: Math.max(0, column1Based - 1) }
    });
    return extractHoverText(res);
  }

  async documentSymbols(filePath: string): Promise<LspSymbolResult[]> {
    const uri = await this.syncFile(filePath);
    const res = await this.sendRequest('textDocument/documentSymbol', {
      textDocument: { uri }
    });
    return flattenDocumentSymbols(res, path.resolve(filePath));
  }

  async workspaceSymbols(query: string): Promise<LspSymbolResult[]> {
    await this.ensureInitialized();
    const res = await this.sendRequest('workspace/symbol', { query: String(query || '').slice(0, 200) });
    return flattenDocumentSymbols(res, this.workspaceRoot);
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  killSync(): void {
    this.closed = true;
    const proc = this.proc;
    this.proc = null;
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }
    this.openDocs.clear();
    this.diagnostics.clear();
    this.diagnosticsSeq.clear();
    this.diagnosticWaiters.clear();
  }

  private killProcess(): void {
    const proc = this.proc;
    this.proc = null;
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.proc && this.proc.stdin.writable) {
        await Promise.race([
          this.sendRequest('shutdown', null, 1500),
          new Promise((r) => setTimeout(r, 1500).unref?.())
        ]).catch(() => {});
        try { this.sendNotification('exit'); } catch { /* ignore */ }
      }
    } finally {
      this.rejectAllPending(new Error('LSP session closed.'));
      this.killProcess();
      this.openDocs.clear();
      this.diagnostics.clear();
      this.diagnosticWaiters.clear();
    }
  }
}

export class LspSessionManager {
  private sessions = new Map<string, LspSession>();

  private sessionKey(serverId: string, workspaceRoot: string): string {
    return `${serverId}::${path.resolve(workspaceRoot)}`;
  }

  listActive(): Array<{ serverId: string; workspaceRoot: string; alive: boolean }> {
    return [...this.sessions.values()].map((s) => ({
      serverId: s.serverId,
      workspaceRoot: s.workspaceRoot,
      alive: s.isAlive()
    }));
  }

  getExistingSessionForFile(filePath: string, boundaryRoot: string): LspSession | null {
    const resolved = path.resolve(filePath);
    for (const session of this.sessions.values()) {
      if (!session.isAlive()) continue;
      const rel = path.relative(session.workspaceRoot, resolved);
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
        const resolvedServer = resolveLspServerForFile(resolved, boundaryRoot);
        if (resolvedServer && resolvedServer.spec.id === session.serverId) {
          return session;
        }
      }
    }
    return null;
  }

  async getOrStartSession(options: LspSessionStartOptions): Promise<LspSession> {
    const key = this.sessionKey(options.serverId, options.workspaceRoot);
    const existing = this.sessions.get(key);
    if (existing && existing.isAlive()) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    if (existing) {
      await existing.shutdown().catch(() => {});
      this.sessions.delete(key);
    }

    if (this.sessions.size >= MAX_SESSIONS) {
      // Evict least-recently-used session
      let oldestKey: string | null = null;
      let oldestTs = Infinity;
      for (const [k, sess] of this.sessions.entries()) {
        if (sess.lastUsedAt < oldestTs) {
          oldestTs = sess.lastUsedAt;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        await this.sessions.get(oldestKey)?.shutdown().catch(() => {});
        this.sessions.delete(oldestKey);
      }
    }

    const session = new LspSession(options);
    this.sessions.set(key, session);
    try {
      await session.ensureInitialized();
      return session;
    } catch (err) {
      this.sessions.delete(key);
      await session.shutdown().catch(() => {});
      throw err;
    }
  }

  async getOrStartForFile(
    filePath: string,
    boundaryRoot: string,
    env: NodeJS.ProcessEnv = process.env
  ): Promise<{ session: LspSession; serverId: string; label: string } | null> {
    const resolved = resolveLspServerForFile(filePath, boundaryRoot, env);
    if (!resolved) return null;
    const lspRoot = findWorkspaceRootForLsp(filePath, resolved.spec, boundaryRoot);
    const session = await this.getOrStartSession({
      serverId: resolved.spec.id,
      command: resolved.executablePath,
      args: resolved.spec.args,
      workspaceRoot: lspRoot,
      env
    });
    return { session, serverId: resolved.spec.id, label: resolved.spec.label };
  }

  async shutdownAll(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map((s) => s.shutdown().catch(() => {})));
  }

  killAllSync(): void {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    for (const sess of all) {
      try { sess.killSync(); } catch { /* ignore */ }
    }
  }
}

export const lspSessionManager = new LspSessionManager();

process.on('exit', () => {
  lspSessionManager.killAllSync();
});

/**
 * Fail-open post-edit diagnostic hook. Only queries an ALREADY-ACTIVE LSP
 * session for the edited file's workspace so standard edits never incur cold
 * LSP startup latency or hang tests.
 */
export async function collectActivePostEditDiagnostics(
  filePath: string,
  workspaceRoot: string,
  content?: string,
  waitMs = 350
): Promise<LspDiagnostic[]> {
  try {
    const session = lspSessionManager.getExistingSessionForFile(filePath, workspaceRoot);
    if (!session) return [];
    const diags = await session.getDiagnostics(filePath, waitMs, content);
    return diags.filter((d) => d.severity === 'error' || d.severity === 'warning').slice(0, 12);
  } catch {
    return [];
  }
}

export function formatDiagnosticsCompact(diagnostics: readonly LspDiagnostic[], workspaceRoot?: string): string {
  if (diagnostics.length === 0) return 'No diagnostics (0 errors, 0 warnings).';
  const base = workspaceRoot ? path.resolve(workspaceRoot) : null;
  return diagnostics.map((d) => {
    const rel = base ? path.relative(base, d.file) : d.file;
    const shownPath = rel && !rel.startsWith('..') ? rel : d.file;
    const codePart = d.code ? ` ${d.code}` : '';
    const srcPart = d.source ? ` (${d.source})` : '';
    return `${safeDisplay(shownPath)}:${d.line}:${d.column} [${d.severity}${codePart}]${srcPart} ${d.message}`;
  }).join('\n');
}
