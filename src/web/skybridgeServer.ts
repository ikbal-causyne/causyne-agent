/**
 * Causyne Local Skybridge Server (`causyne web`)
 *
 * Foreground, user-initiated, loopback-only (`127.0.0.1`) HTTP + NDJSON bridge
 * connecting a local browser tab (or verified `https://causyne.com` origin) to
 * the user's selected local workspace folder and full Causyne Agent runtime.
 *
 * Security invariants:
 *   1. Binds strictly to `127.0.0.1` — never `0.0.0.0` or LAN interfaces.
 *   2. Strict `Host` header validation (`127.0.0.1:<port>` / `localhost:<port>`)
 *      blocks DNS Rebinding attacks.
 *   3. Strict `Origin` allowlist (`http://127.0.0.1:<port>`, `http://localhost:<port>`,
 *      `https://causyne.com`, `https://www.causyne.com`) + Chrome Private Network
 *      Access (PNA) preflight headers block CSRF & cross-site hijacking.
 *   4. 256-bit cryptographic session nonce verified with `crypto.timingSafeEqual`
 *      on every `/api/*` endpoint via `Authorization: Bearer <token>`.
 *   5. Every file read/list/write is strictly locked inside `workspaceRoot` via
 *      `isPhysicalPathAllowed()` + `atomicWriteFileSync()` + audit logging.
 *   6. Zero persistent daemon, zero `postinstall`, zero outbound reverse tunnel.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { AgentLoop } from '../agentLoop.js';
import { isPhysicalPathAllowed, physicalPath } from '../agent/workspaceBoundary.js';
import { atomicWriteFileSync } from '../infra/atomicWriter.js';
import { loadConfig } from '../config.js';
import { detectZeroCostProviders } from '../zeroCostRouting.js';
import { auditLog } from '../auditLog.js';
import { getPackageVersion } from '../version.js';
import { formatRedactedProviderErrorReport, redactProviderSecrets } from '../providers/byokHttp.js';
import { isIgnoredByCausyneIgnore } from '../ignoreRules.js';
import { renderSkybridgeHtml } from './skybridgeUi.js';

const MAX_JSON_BODY_BYTES = 1024 * 1024; // 1 MiB
const MAX_FILE_READ_BYTES = 512 * 1024;  // 512 KiB
const MAX_FILE_WRITE_BYTES = 2 * 1024 * 1024; // 2 MiB
const MAX_LIST_ENTRIES = 250;
const SKIPPED_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.venv']);
const ALLOWED_REMOTE_ORIGINS = new Set(['https://causyne.com', 'https://www.causyne.com']);

export interface SkybridgeLoopLike {
  run(): Promise<void>;
  abort?(): void;
  resolveApproval?(toolCallId: string, approved: boolean): void;
}

export type SkybridgeLoopFactory = (
  sink: { readyState: number; send(raw: string): void },
  taskId: string,
  prompt: string,
  options: { workspaceRoot: string; mode: string }
) => SkybridgeLoopLike;

export interface StartSkybridgeOptions {
  workspaceRoot?: string | undefined;
  port?: number | undefined;
  token?: string | undefined;
  allowedOrigins?: readonly string[] | undefined;
  loopFactory?: SkybridgeLoopFactory | undefined;
}

export interface SkybridgeHandle {
  url: string;
  origin: string;
  port: number;
  token: string;
  workspaceRoot: string;
  close(): Promise<void>;
}

export function isAllowedSkybridgeHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader || typeof hostHeader !== 'string') return false;
  const normalized = hostHeader.trim().toLowerCase();
  return normalized === `127.0.0.1:${port}`
    || normalized === `localhost:${port}`
    || normalized === `[::1]:${port}`;
}

export function isAllowedSkybridgeOrigin(
  originHeader: string | undefined,
  port: number,
  extraOrigins: readonly string[] = []
): boolean {
  if (!originHeader || typeof originHeader !== 'string') return true;
  const trimmed = originHeader.trim();
  if (!trimmed || trimmed === 'null') return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  const canonical = parsed.origin.toLowerCase();
  if (canonical === `http://127.0.0.1:${port}` || canonical === `http://localhost:${port}`) {
    return true;
  }
  if (ALLOWED_REMOTE_ORIGINS.has(canonical)) return true;
  for (const extra of extraOrigins) {
    try {
      const parsedExtra = new URL(extra);
      if (parsedExtra.protocol === 'https:' && parsedExtra.origin.toLowerCase() === canonical) {
        return true;
      }
    } catch {
      // ignore invalid extra origin
    }
  }
  return false;
}

function timingSafeBearerMatch(authHeader: string | undefined, expectedToken: string): boolean {
  if (!authHeader || typeof authHeader !== 'string') return false;
  const prefix = 'Bearer ';
  if (!authHeader.startsWith(prefix)) return false;
  const supplied = authHeader.slice(prefix.length).trim();
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expectedToken, 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

function applySecurityHeaders(
  res: http.ServerResponse,
  originHeader: string | undefined,
  originAllowed: boolean
): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  if (originHeader && originAllowed) {
    res.setHeader('Access-Control-Allow-Origin', originHeader);
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Vary', 'Origin, Access-Control-Request-Private-Network');
  }
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(body);
}

async function readJsonBody(req: http.IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error('Request body exceeded maximum allowed size.');
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON request body must be an object.');
  }
  return parsed as Record<string, any>;
}

function resolveWorkspaceRelativePath(workspaceRoot: string, rawRel: string): string | null {
  if (typeof rawRel !== 'string' || rawRel.includes('\0')) return null;
  const cleaned = rawRel.trim();
  if (!cleaned) return null;
  if (path.isAbsolute(cleaned)) return null;
  const candidate = path.resolve(workspaceRoot, cleaned);
  if (!isPhysicalPathAllowed(candidate, [workspaceRoot], false)) return null;
  return candidate;
}

function listWorkspaceEntries(workspaceRoot: string, relDir: string): Array<{ path: string; type: 'dir' | 'file'; size: number }> {
  const targetDir = relDir ? resolveWorkspaceRelativePath(workspaceRoot, relDir) : workspaceRoot;
  if (!targetDir) throw new Error('Requested directory is outside the locked workspace.');
  const dirents = fs.readdirSync(targetDir, { withFileTypes: true });
  const entries: Array<{ path: string; type: 'dir' | 'file'; size: number }> = [];
  for (const d of dirents) {
    if (entries.length >= MAX_LIST_ENTRIES) break;
    if (d.isSymbolicLink()) continue;
    if (d.isDirectory() && SKIPPED_DIRS.has(d.name)) continue;
    const abs = path.join(targetDir, d.name);
    if (!isPhysicalPathAllowed(abs, [workspaceRoot], false)) continue;
    if (isIgnoredByCausyneIgnore(abs, workspaceRoot, d.isDirectory())) continue;
    const rel = path.relative(workspaceRoot, abs).split(path.sep).join('/');
    let size = 0;
    if (d.isFile()) {
      try { size = fs.statSync(abs).size; } catch { size = 0; }
    }
    entries.push({ path: rel, type: d.isDirectory() ? 'dir' : 'file', size });
  }
  entries.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'dir' ? -1 : 1));
  return entries;
}

export async function startSkybridgeServer(options: StartSkybridgeOptions = {}): Promise<SkybridgeHandle> {
  const rawRoot = options.workspaceRoot || process.cwd();
  const resolvedRoot = physicalPath(rawRoot);
  if (!resolvedRoot || !fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
    throw new Error(`Invalid Skybridge workspace directory: ${rawRoot}`);
  }
  const workspaceRoot = resolvedRoot;
  const token = options.token || crypto.randomBytes(32).toString('base64url');
  const requestedPort = typeof options.port === 'number' && Number.isInteger(options.port) && options.port >= 0 && options.port <= 65535
    ? options.port
    : 0;
  const extraOrigins = options.allowedOrigins ?? [];
  const version = getPackageVersion();
  const loopFactory: SkybridgeLoopFactory = options.loopFactory ?? ((sink, taskId, prompt, opts) => {
    const loop = new AgentLoop(sink, taskId, prompt, {
      workspaceRoot: opts.workspaceRoot
    });
    if (loop.sandbox && (opts.mode === 'A' || opts.mode === 'B' || opts.mode === 'C')) {
      loop.sandbox.autonomyMode = opts.mode;
    }
    return {
      run: () => loop.run(),
      abort: () => loop.abort(),
      resolveApproval: (toolCallId: string, approved: boolean) => {
        const resolver = loop.pendingApprovals.get(toolCallId);
        if (resolver) resolver(approved);
      }
    };
  });

  let boundPort = requestedPort;
  let activeLoop: SkybridgeLoopLike | null = null;
  let taskCounter = 0;

  const server = http.createServer(async (req, res) => {
    const hostHeader = req.headers.host;
    if (!isAllowedSkybridgeHost(hostHeader, boundPort)) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Forbidden Host header (DNS rebinding protection).' }));
      return;
    }

    const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const originAllowed = isAllowedSkybridgeOrigin(originHeader, boundPort, extraOrigins);
    applySecurityHeaders(res, originHeader, originAllowed);

    if (originHeader && !originAllowed) {
      sendJson(res, 403, { error: 'Origin not permitted by Causyne Skybridge.' });
      return;
    }

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || '/', `http://127.0.0.1:${boundPort}`);
    const pathname = parsedUrl.pathname;

    if (req.method === 'GET' && pathname === '/') {
      const cspNonce = crypto.randomBytes(16).toString('base64url');
      res.statusCode = 200;
      res.setHeader(
        'Content-Security-Policy',
        `default-src 'self'; script-src 'self' 'nonce-${cspNonce}'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'`
      );
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(renderSkybridgeHtml({
        cspNonce,
        workspaceName: path.basename(workspaceRoot),
        version
      }));
      return;
    }

    if (!pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'Not found.' });
      return;
    }

    if (!timingSafeBearerMatch(req.headers.authorization, token)) {
      sendJson(res, 401, { error: 'Unauthorized. Valid Skybridge Bearer token required.' });
      return;
    }

    try {
      if (req.method === 'GET' && pathname === '/api/health') {
        const config = loadConfig();
        const zeroCost = await detectZeroCostProviders({ config, probeOllama: false });
        const readyZeroCost = zeroCost.filter((z) => z.readiness === 'ready');
        sendJson(res, 200, {
          ok: true,
          version,
          workspaceRoot,
          workspaceName: path.basename(workspaceRoot),
          provider: config.provider || 'unconfigured',
          model: config.model || 'default',
          zeroCostReadyCount: readyZeroCost.length,
          busy: activeLoop !== null
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/files') {
        const dir = parsedUrl.searchParams.get('dir') || '';
        const entries = listWorkspaceEntries(workspaceRoot, dir);
        sendJson(res, 200, { ok: true, dir, entries });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/file') {
        const rel = parsedUrl.searchParams.get('path') || '';
        const abs = resolveWorkspaceRelativePath(workspaceRoot, rel);
        if (!abs) {
          sendJson(res, 403, { error: 'Path is outside the locked workspace boundary.' });
          return;
        }
        const stat = fs.lstatSync(abs);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          sendJson(res, 403, { error: 'Only regular workspace files can be read.' });
          return;
        }
        if (stat.size > MAX_FILE_READ_BYTES) {
          sendJson(res, 413, { error: `File exceeds ${MAX_FILE_READ_BYTES} byte preview limit.` });
          return;
        }
        const content = fs.readFileSync(abs, 'utf8');
        sendJson(res, 200, {
          ok: true,
          path: path.relative(workspaceRoot, abs).split(path.sep).join('/'),
          size: stat.size,
          content
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/file') {
        const body = await readJsonBody(req, MAX_FILE_WRITE_BYTES);
        const rel = typeof body.path === 'string' ? body.path : '';
        const content = typeof body.content === 'string' ? body.content : null;
        if (!rel || content === null) {
          sendJson(res, 400, { error: 'Both `path` and string `content` are required.' });
          return;
        }
        const abs = resolveWorkspaceRelativePath(workspaceRoot, rel);
        if (!abs) {
          sendJson(res, 403, { error: 'Refusing write outside locked workspace boundary.' });
          return;
        }
        const relNormalized = path.relative(workspaceRoot, abs).split(path.sep).join('/');
        if (isIgnoredByCausyneIgnore(abs, workspaceRoot, false)) {
          sendJson(res, 403, { error: 'File path is blocked by .causyneignore.' });
          return;
        }
        const byteCount = Buffer.byteLength(content, 'utf8');
        if (byteCount > MAX_FILE_WRITE_BYTES) {
          sendJson(res, 413, { error: 'File content exceeds maximum write limit.' });
          return;
        }
        atomicWriteFileSync(abs, content);
        auditLog.log({ event: 'skybridge_file_write', path: relNormalized, bytes: byteCount });
        sendJson(res, 200, { ok: true, path: relNormalized, bytes: byteCount });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/doctor/report') {
        const config = loadConfig();
        sendJson(res, 200, {
          ok: true,
          report: formatRedactedProviderErrorReport({
            provider: config.provider,
            model: config.model,
            causyneVersion: version
          })
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/approve') {
        const body = await readJsonBody(req);
        const toolCallId = typeof body.toolCallId === 'string' ? body.toolCallId.trim() : '';
        const approved = body.approved === true;
        if (!toolCallId || !activeLoop?.resolveApproval) {
          sendJson(res, 400, { error: 'No active pending approval matches that toolCallId.' });
          return;
        }
        activeLoop.resolveApproval(toolCallId, approved);
        sendJson(res, 200, { ok: true, toolCallId, approved });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/stop') {
        if (activeLoop?.abort) activeLoop.abort();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/chat') {
        if (activeLoop) {
          sendJson(res, 409, { error: 'Another task is currently running. Stop it before starting a new one.' });
          return;
        }
        const body = await readJsonBody(req);
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        const rawMode = typeof body.mode === 'string' ? body.mode.trim().toUpperCase() : 'B';
        const mode = rawMode === 'A' || rawMode === 'B' || rawMode === 'C' ? rawMode : 'B';
        if (!prompt) {
          sendJson(res, 400, { error: 'Prompt text is required.' });
          return;
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');

        const taskId = `web-${++taskCounter}-${Date.now()}`;
        const writeFrame = (raw: string): void => {
          if (res.writableEnded || res.destroyed) return;
          const clean = raw.replace(/\r?\n/g, ' ');
          res.write(`${clean}\n`);
        };
        const sink = { readyState: 1, send: writeFrame };
        const loop = loopFactory(sink, taskId, prompt, { workspaceRoot, mode });
        activeLoop = loop;
        req.on('close', () => {
          if (activeLoop === loop && !res.writableEnded) {
            loop.abort?.();
          }
        });

        try {
          await loop.run();
          writeFrame(JSON.stringify({ type: 'done', taskId }));
        } catch (err: unknown) {
          auditLog.log({
            event: 'skybridge_chat_error',
            taskId,
            detail: redactProviderSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300)
          });
          writeFrame(JSON.stringify({
            type: 'error',
            message: 'Task failed. Inspect local audit log or run `/doctor --report` for sanitized details.'
          }));
        } finally {
          if (activeLoop === loop) activeLoop = null;
          if (!res.writableEnded) res.end();
        }
        return;
      }

      sendJson(res, 404, { error: 'Unknown Skybridge API endpoint.' });
    } catch (err: unknown) {
      const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as any).code) : '';
      const status = code === 'ENOENT' ? 404 : 400;
      auditLog.log({
        event: 'skybridge_request_error',
        path: pathname,
        status,
        detail: redactProviderSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300)
      });
      const safeError = status === 404
        ? 'Requested workspace resource was not found.'
        : 'Skybridge request could not be processed.';
      if (!res.headersSent) sendJson(res, status, { error: safeError });
      else if (!res.writableEnded) res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, '127.0.0.1', () => {
      server.off('error', reject);
      const addr = server.address() as AddressInfo | null;
      boundPort = addr?.port ?? requestedPort;
      resolve();
    });
  });

  const origin = `http://127.0.0.1:${boundPort}`;
  const url = `${origin}/#token=${token}`;
  auditLog.log({ event: 'skybridge_started', port: boundPort, workspaceRoot });

  return {
    url,
    origin,
    port: boundPort,
    token,
    workspaceRoot,
    close: async () => {
      if (activeLoop?.abort) activeLoop.abort();
      activeLoop = null;
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
