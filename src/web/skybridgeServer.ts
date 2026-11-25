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
import { createApprovalScope } from '../approvalGrants.js';
import { isPhysicalPathAllowed, physicalPath } from '../agent/workspaceBoundary.js';
import { atomicWriteFileSync } from '../infra/atomicWriter.js';
import {
  applyProviderOverrides,
  loadConfig,
  resolveProviderApiKey,
  saveConfig
} from '../config.js';
import { detectZeroCostProviders } from '../zeroCostRouting.js';
import { DEFAULT_MODEL_BY_PROVIDER, MODEL_CATALOGUE } from '../modelCatalogue.js';
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  renameSession,
  saveSessionMessages,
  type SessionMessage
} from '../sessionJournal.js';
import { collectWorkingTreeDiff } from '../diffReview.js';
import { auditLog } from '../auditLog.js';
import { getPackageVersion } from '../version.js';
import { formatRedactedProviderErrorReport, redactProviderSecrets } from '../providers/byokHttp.js';
import { isIgnoredByCausyneIgnore } from '../ignoreRules.js';
import { listCommands, parseCommand, runCommand } from '../commands.js';
import { formatByokProbeReport, runZeroSpendByokProbe } from '../verification/byokSmokeProbe.js';
import { listGroups } from '../checkpoints.js';
import { listCompiledSkills } from '../skillsManager.js';
import { serverStatus } from '../mcp/mcpRegistry.js';
import { listAllPeers } from '../acp/peerProfiles.js';
import { listWorktrees } from '../worktreeManager.js';
import { backgroundTaskManager } from '../backgroundTasks.js';
import {
  causyneBrowser,
  expandSearchMacro,
  type BrowserEnginePreference,
  type LiveBrowserInteraction
} from '../browser/causyneBrowser.js';
import {
  discoverLocalCdpTabs,
  importExplicitUserBrowserData,
  syncLocalCdpTabToCausyne
} from './skybridgeBrowserBridge.js';
import {
  CAUSYNE_BROWSER_MCP_NAME,
  handleBrowserMcpRpc,
  type JsonRpcMessage
} from './skybridgeBrowserMcp.js';
import type { McpServer } from '../acp/protocol.js';
import { renderSkybridgeHtml } from './skybridgeUi.js';

const MAX_JSON_BODY_BYTES = 1024 * 1024;
const MAX_FILE_READ_BYTES = 512 * 1024;
const MAX_FILE_WRITE_BYTES = 2 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 32 * 1024;
const MAX_ATTACHMENTS = 6;
const MAX_LIST_ENTRIES = 250;
const SKIPPED_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.venv']);
const ALLOWED_REMOTE_ORIGINS = new Set(['https://causyne.com', 'https://www.causyne.com']);
const SAFE_SESSION_ID_RE = /^s_[a-zA-Z0-9_-]{3,80}$/;
const SAFE_PROVIDER_RE = /^[a-zA-Z0-9._/-]{1,64}$/;
const SAFE_MODEL_RE = /^[a-zA-Z0-9._/:() -]{1,128}$/;

const PROVIDER_KEY_FOR_CATALOG_LABEL: Record<string, string> = {
  'DeepSeek': 'deepseek',
  'Qwen': 'qwen',
  'Anthropic': 'anthropic',
  'OpenAI': 'openai',
  'Gemini': 'gemini',
  'Meta (Muse)': 'muse',
  'Ollama (Local)': 'ollama',
  'Alibaba (DashScope)': 'dashscope-byok',
  'Moonshot (Kimi)': 'moonshot',
  'xAI (Grok)': 'xai',
  'Google Antigravity': 'antigravity',
  'Pi (Local Peer)': 'pi',
  'ACP (Peer Agents)': 'acp',
  'OpenCode (ACP)': 'acp/opencode',
  'Claude Code (ACP)': 'acp/claude',
  'OpenRouter (Free)': 'openrouter',
  'Groq (Free Tier)': 'groq',
  'Cerebras (Free Tier)': 'cerebras',
  'Mistral (Free Tier)': 'mistral'
};

export interface SkybridgeLoopLike {
  run(): Promise<void>;
  abort?(): void;
  resolveApproval?(toolCallId: string, approved: boolean): void;
  grantAlways?(toolName: string): void;
}

export type SkybridgeLoopFactory = (
  sink: { readyState: number; send(raw: string): void },
  taskId: string,
  prompt: string,
  options: {
    workspaceRoot: string;
    mode: string;
    sessionId?: string | undefined;
    provider?: string | undefined;
    model?: string | undefined;
  }
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
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

async function readJsonBody(
  req: http.IncomingMessage,
  maxBytes = MAX_JSON_BODY_BYTES
): Promise<Record<string, any>> {
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

function listWorkspaceEntries(
  workspaceRoot: string,
  relDir: string,
  query = ''
): Array<{ path: string; name: string; type: 'dir' | 'file'; size: number }> {
  const targetDir = relDir ? resolveWorkspaceRelativePath(workspaceRoot, relDir) : workspaceRoot;
  if (!targetDir) throw new Error('Requested directory is outside the locked workspace.');
  const q = query.trim().toLowerCase();
  const entries: Array<{ path: string; name: string; type: 'dir' | 'file'; size: number }> = [];

  const scan = (dir: string, depth: number): void => {
    if (entries.length >= MAX_LIST_ENTRIES) return;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (entries.length >= MAX_LIST_ENTRIES) break;
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory() && SKIPPED_DIRS.has(d.name)) continue;
      const abs = path.join(dir, d.name);
      if (!isPhysicalPathAllowed(abs, [workspaceRoot], false)) continue;
      if (isIgnoredByCausyneIgnore(abs, workspaceRoot, d.isDirectory())) continue;
      const rel = path.relative(workspaceRoot, abs).split(path.sep).join('/');
      const isDir = d.isDirectory();
      let size = 0;
      if (!isDir) {
        try { size = fs.statSync(abs).size; } catch { size = 0; }
      }
      if (!q || rel.toLowerCase().includes(q)) {
        entries.push({ path: rel, name: d.name, type: isDir ? 'dir' : 'file', size });
      }
      if (q && isDir && depth < 3) {
        scan(abs, depth + 1);
      }
    }
  };

  scan(targetDir, 0);
  entries.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'dir' ? -1 : 1));
  return entries;
}

function extractSessionDisplayMessages(
  messages: readonly SessionMessage[]
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const msg of messages) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    let text = '';
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      const parts: string[] = [];
      for (const block of msg.content) {
        if (block && typeof block === 'object' && typeof (block as any).text === 'string') {
          parts.push(String((block as any).text));
        }
      }
      text = parts.join('\n');
    }
    const trimmed = text.trim();
    if (!trimmed) continue;
    out.push({ role: msg.role, content: trimmed });
  }
  return out;
}

function buildWorkspacePromptWithAttachments(
  workspaceRoot: string,
  prompt: string,
  rawAttachments: unknown
): { effectivePrompt: string; attachedPaths: string[] } {
  if (!Array.isArray(rawAttachments) || rawAttachments.length === 0) {
    return { effectivePrompt: prompt, attachedPaths: [] };
  }
  const attachedPaths: string[] = [];
  const sections: string[] = [];
  for (const raw of rawAttachments.slice(0, MAX_ATTACHMENTS)) {
    if (typeof raw !== 'string') continue;
    const abs = resolveWorkspaceRelativePath(workspaceRoot, raw);
    if (!abs) continue;
    if (isIgnoredByCausyneIgnore(abs, workspaceRoot, false)) continue;
    try {
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      const buf = fs.readFileSync(abs);
      if (buf.includes(0)) continue;
      const sliced = buf.length > MAX_ATTACHMENT_BYTES ? buf.subarray(0, MAX_ATTACHMENT_BYTES) : buf;
      const rel = path.relative(workspaceRoot, abs).split(path.sep).join('/');
      const truncatedNote = buf.length > MAX_ATTACHMENT_BYTES ? '\n[truncated]' : '';
      attachedPaths.push(rel);
      sections.push(`--- Attached workspace file: ${rel} ---\n${sliced.toString('utf8')}${truncatedNote}`);
    } catch {
      // skip unreadable attachment
    }
  }
  if (sections.length === 0) {
    return { effectivePrompt: prompt, attachedPaths: [] };
  }
  return {
    effectivePrompt: `${sections.join('\n\n')}\n\n${prompt}`,
    attachedPaths
  };
}

function workspaceMatchesSession(sessionWorkspace: string, workspaceRoot: string): boolean {
  if (!sessionWorkspace) return false;
  const resolvedSession = physicalPath(sessionWorkspace);
  return resolvedSession === workspaceRoot || sessionWorkspace === workspaceRoot;
}

function parseSessionIdRoute(pathname: string): string | null {
  const prefix = '/api/sessions/';
  if (!pathname.startsWith(prefix)) return null;
  const raw = pathname.slice(prefix.length);
  if (!raw || raw.includes('/')) return null;
  let decoded = '';
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return SAFE_SESSION_ID_RE.test(decoded) ? decoded : null;
}

export async function startSkybridgeServer(options: StartSkybridgeOptions = {}): Promise<SkybridgeHandle> {
  const rawRoot = options.workspaceRoot || process.cwd();
  const resolvedRoot = physicalPath(rawRoot);
  if (!resolvedRoot || !fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
    throw new Error(`Invalid Skybridge workspace directory: ${rawRoot}`);
  }
  const workspaceRoot = resolvedRoot;
  const token = options.token || crypto.randomBytes(32).toString('base64url');
  const requestedPort = typeof options.port === 'number'
    && Number.isInteger(options.port)
    && options.port >= 0
    && options.port <= 65535
    ? options.port
    : 0;
  const extraOrigins = options.allowedOrigins ?? [];
  const version = getPackageVersion();
  const hasCustomFactory = typeof options.loopFactory === 'function';
  let boundPort = requestedPort;
  const serverApprovalScope = createApprovalScope();
  const buildSharedBrowserPeerMcp = (): McpServer[] => {
    if (!boundPort) return [];
    return [{
      type: 'http',
      name: CAUSYNE_BROWSER_MCP_NAME,
      url: `http://127.0.0.1:${boundPort}/api/mcp/browser`,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }]
    }];
  };
  const loopFactory: SkybridgeLoopFactory = options.loopFactory ?? ((sink, taskId, prompt, opts) => {
    const loopOptions: {
      workspaceRoot: string;
      memorySessionId?: string | null;
      provider?: string;
      model?: string;
      approvalScope?: ReturnType<typeof createApprovalScope>;
      peerMcpServers?: McpServer[];
    } = {
      workspaceRoot: opts.workspaceRoot,
      approvalScope: serverApprovalScope,
      peerMcpServers: buildSharedBrowserPeerMcp()
    };
    if (opts.sessionId) loopOptions.memorySessionId = opts.sessionId;
    if (opts.provider) loopOptions.provider = opts.provider;
    if (opts.model) loopOptions.model = opts.model;
    const loop = new AgentLoop(sink, taskId, prompt, loopOptions);
    if (loop.sandbox && (opts.mode === 'A' || opts.mode === 'B' || opts.mode === 'C')) {
      loop.sandbox.autonomyMode = opts.mode;
    }
    return {
      run: () => loop.run(),
      abort: () => loop.abort(),
      resolveApproval: (toolCallId: string, approved: boolean) => {
        const resolver = loop.pendingApprovals.get(toolCallId);
        if (resolver) resolver(approved);
      },
      grantAlways: (toolName: string) => {
        serverApprovalScope.grantAlways(toolName);
      }
    };
  });

  let activeLoop: SkybridgeLoopLike | null = null;
  let taskCounter = 0;
  let browserControlOwner: 'human' | 'agent' = 'human';
  let browserAgentActivity: { active: boolean; tool: string; detail: string; updatedAt: number } = {
    active: false,
    tool: '',
    detail: '',
    updatedAt: 0
  };
  const browserStreamClients = new Set<(payload: Record<string, unknown>) => void>();
  const broadcastBrowserNotice = (payload: Record<string, unknown>): void => {
    for (const send of browserStreamClients) {
      try {
        send(payload);
      } catch {
        // Isolate individual stream clients.
      }
    }
  };

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
        `default-src 'self'; script-src 'self' 'nonce-${cspNonce}'; `
        + `style-src 'self' 'unsafe-inline'; img-src 'self' data:; `
        + `frame-src http://127.0.0.1:* http://localhost:*; `
        + `connect-src 'self'; frame-ancestors 'none'`
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
          model: config.model || DEFAULT_MODEL_BY_PROVIDER[String(config.provider || '')] || 'default',
          zeroCostReadyCount: readyZeroCost.length,
          zeroCostRoutes: readyZeroCost.map((z) => ({
            id: z.id,
            provider: z.provider,
            model: z.model,
            label: z.label,
            costTier: z.costTier
          })),
          busy: activeLoop !== null
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/models') {
        const config = loadConfig();
        const zeroCost = await detectZeroCostProviders({ config, probeOllama: false });
        const readySet = new Set(zeroCost.filter((z) => z.readiness === 'ready').map((z) => z.provider));
        const groups = Object.entries(MODEL_CATALOGUE).map(([label, models]) => {
          const providerId = PROVIDER_KEY_FOR_CATALOG_LABEL[label] || label.toLowerCase();
          const hasKey = Boolean(resolveProviderApiKey(config, providerId));
          const isZeroCostReady = readySet.has(providerId);
          return {
            label,
            provider: providerId,
            configured: hasKey || isZeroCostReady,
            zeroCostReady: isZeroCostReady,
            defaultModel: DEFAULT_MODEL_BY_PROVIDER[providerId] || models[0] || '',
            models
          };
        });
        sendJson(res, 200, {
          ok: true,
          activeProvider: config.provider || 'unconfigured',
          activeModel: config.model || DEFAULT_MODEL_BY_PROVIDER[String(config.provider || '')] || '',
          zeroCost: zeroCost.map((z) => ({
            id: z.id,
            provider: z.provider,
            model: z.model,
            label: z.label,
            costTier: z.costTier,
            readiness: z.readiness
          })),
          groups
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/model') {
        const body = await readJsonBody(req);
        const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
        const model = typeof body.model === 'string' ? body.model.trim() : '';
        if (!provider || !SAFE_PROVIDER_RE.test(provider)) {
          sendJson(res, 400, { error: 'Valid provider identifier is required.' });
          return;
        }
        if (model && !SAFE_MODEL_RE.test(model)) {
          sendJson(res, 400, { error: 'Invalid model identifier.' });
          return;
        }
        const config = loadConfig();
        const resolvedModel = model || DEFAULT_MODEL_BY_PROVIDER[provider] || '';
        applyProviderOverrides(config, provider, resolvedModel);
        saveConfig(config);
        auditLog.log({
          event: 'skybridge_model_switch',
          provider: config.provider,
          model: config.model
        });
        sendJson(res, 200, {
          ok: true,
          provider: config.provider,
          model: config.model || DEFAULT_MODEL_BY_PROVIDER[String(config.provider || '')] || 'default'
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/sessions') {
        const all = listSessions();
        const scoped = all.filter((row) => workspaceMatchesSession(row.workspace, workspaceRoot));
        sendJson(res, 200, {
          ok: true,
          sessions: scoped.slice(0, 50).map((row) => ({
            id: row.id,
            title: row.title,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            messageCount: row.messageCount
          }))
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/sessions') {
        const body = await readJsonBody(req);
        const rawTitle = typeof body.title === 'string' ? body.title.trim().slice(0, 80) : '';
        const created = createSession(workspaceRoot, rawTitle || 'Untitled', false);
        sendJson(res, 201, {
          ok: true,
          session: {
            id: created.id,
            title: created.title,
            createdAt: created.createdAt,
            updatedAt: created.updatedAt,
            messageCount: 0,
            messages: []
          }
        });
        return;
      }

      const sessionIdParam = parseSessionIdRoute(pathname);
      if (sessionIdParam) {
        const existing = getSession(sessionIdParam);
        if (!existing || !workspaceMatchesSession(existing.workspace, workspaceRoot)) {
          sendJson(res, 404, { error: 'Session not found in this workspace.' });
          return;
        }
        if (req.method === 'GET') {
          sendJson(res, 200, {
            ok: true,
            session: {
              id: existing.id,
              title: existing.title,
              createdAt: existing.createdAt,
              updatedAt: existing.updatedAt,
              messageCount: existing.messages.length,
              messages: extractSessionDisplayMessages(existing.messages)
            }
          });
          return;
        }
        if (req.method === 'PATCH') {
          const body = await readJsonBody(req);
          const nextTitle = typeof body.title === 'string' ? body.title.trim().slice(0, 80) : '';
          if (!nextTitle) {
            sendJson(res, 400, { error: 'A non-empty session title is required.' });
            return;
          }
          const updated = renameSession(existing.id, nextTitle);
          if (!updated) {
            sendJson(res, 400, { error: 'Could not rename session.' });
            return;
          }
          sendJson(res, 200, { ok: true, id: existing.id, title: nextTitle });
          return;
        }
        if (req.method === 'DELETE') {
          const removed = deleteSession(existing.id);
          sendJson(res, removed ? 200 : 404, { ok: removed, id: existing.id });
          return;
        }
      }

      if (req.method === 'GET' && pathname === '/api/files') {
        const dir = parsedUrl.searchParams.get('dir') || '';
        const q = parsedUrl.searchParams.get('q') || '';
        const entries = listWorkspaceEntries(workspaceRoot, dir, q);
        const parentDir = dir ? path.posix.dirname(dir.replace(/\\/g, '/')) : '';
        sendJson(res, 200, {
          ok: true,
          dir,
          parentDir: parentDir === '.' ? '' : parentDir,
          entries
        });
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

      if (req.method === 'GET' && pathname === '/api/diff') {
        const staged = parsedUrl.searchParams.get('staged') === '1';
        try {
          const report = collectWorkingTreeDiff(workspaceRoot, { staged });
          sendJson(res, 200, {
            ok: true,
            isGitRepo: true,
            staged: report.staged,
            totalAdditions: report.totalAdditions,
            totalDeletions: report.totalDeletions,
            truncated: report.truncated,
            files: report.files.slice(0, 60).map((f) => ({
              path: f.displayPath,
              status: f.status,
              additions: f.additions,
              deletions: f.deletions,
              hunks: f.hunks.slice(0, 20).map((h) => ({
                header: h.header,
                lines: h.lines.slice(0, 200)
              }))
            }))
          });
        } catch {
          sendJson(res, 200, {
            ok: true,
            isGitRepo: false,
            staged,
            totalAdditions: 0,
            totalDeletions: 0,
            truncated: false,
            files: []
          });
        }
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

      if (req.method === 'POST' && pathname === '/api/doctor/probe') {
        const report = await runZeroSpendByokProbe();
        sendJson(res, 200, {
          ok: true,
          report: formatByokProbeReport(report),
          summary: {
            testedCount: report.testedCount,
            passedCount: report.passedCount,
            failedCount: report.failedCount,
            skippedCount: report.skippedCount
          }
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/config/key') {
        const body = await readJsonBody(req);
        const provider = typeof body.provider === 'string' ? body.provider.trim().toLowerCase() : '';
        const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
        const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
        if (!provider || forbidden.has(provider) || !SAFE_PROVIDER_RE.test(provider)) {
          sendJson(res, 400, { error: 'Valid provider identifier is required.' });
          return;
        }
        if (!apiKey || apiKey.length < 4 || apiKey.length > 512) {
          sendJson(res, 400, { error: 'API key must be between 4 and 512 characters.' });
          return;
        }
        const config = loadConfig();
        const existingKeys = config.providerKeys && typeof config.providerKeys === 'object' && !Array.isArray(config.providerKeys)
          ? { ...(config.providerKeys as Record<string, string>) }
          : {};
        existingKeys[provider] = apiKey;
        config.providerKeys = existingKeys;
        if (String(config.provider || '').trim().toLowerCase() === provider || body.activate === true) {
          applyProviderOverrides(config, provider, typeof body.model === 'string' ? body.model.trim() : undefined);
        }
        saveConfig(config);
        auditLog.log({ event: 'skybridge_vault_key_saved', provider });
        sendJson(res, 200, {
          ok: true,
          provider,
          configured: true,
          activeProvider: config.provider || 'unconfigured',
          activeModel: config.model || DEFAULT_MODEL_BY_PROVIDER[String(config.provider || '')] || 'default'
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/commands') {
        const commands = listCommands('terminal').map((cmd) => ({
          name: cmd.name,
          aliases: cmd.aliases ?? [],
          usage: cmd.usage,
          description: cmd.description
        }));
        sendJson(res, 200, { ok: true, commands });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/command') {
        const body = await readJsonBody(req);
        let cmdName = '';
        let cmdArgv: string[] = [];
        if (typeof body.input === 'string' && body.input.trim()) {
          const rawLine = body.input.trim().startsWith('/') ? body.input.trim() : `/${body.input.trim()}`;
          const parsed = parseCommand(rawLine);
          if (!parsed) {
            sendJson(res, 400, { error: 'Invalid CLI slash command syntax.' });
            return;
          }
          cmdName = parsed.name;
          cmdArgv = parsed.argv;
        } else if (typeof body.name === 'string' && body.name.trim()) {
          cmdName = body.name.trim().toLowerCase();
          cmdArgv = Array.isArray(body.argv) ? body.argv.map((x: unknown) => String(x ?? '')) : [];
        } else {
          sendJson(res, 400, { error: 'Command input or name is required.' });
          return;
        }
        if (cmdName === 'exit' || cmdName === 'quit') {
          sendJson(res, 200, {
            ok: true,
            command: cmdName,
            title: 'Exit',
            output: 'Press Ctrl+C in the terminal running `causyne web` to stop the local Skybridge server cleanly.'
          });
          return;
        }
        const prevCwd = process.cwd();
        let result: Awaited<ReturnType<typeof runCommand>>;
        try {
          if (prevCwd !== workspaceRoot) process.chdir(workspaceRoot);
          result = await runCommand(cmdName, cmdArgv, {
            surface: 'terminal',
            workspaceRoot,
            cwd: workspaceRoot
          });
        } finally {
          try { if (process.cwd() !== prevCwd) process.chdir(prevCwd); } catch { /* ignore */ }
        }
        auditLog.log({ event: 'skybridge_cli_command', command: cmdName, ok: Boolean(result.ok) });
        sendJson(res, 200, {
          ok: Boolean(result.ok),
          command: cmdName,
          title: typeof result.title === 'string' ? result.title : `/${cmdName}`,
          effect: typeof result.effect === 'string' ? result.effect : null,
          output: redactProviderSecrets(String(result.output || ''))
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/cli/overview') {
        const checkpoints = listGroups(12).map((g) => ({
          id: g.taskId,
          createdAt: g.ts,
          label: g.prompt || g.taskId,
          fileCount: Array.isArray(g.fileEntries) ? g.fileEntries.length : 0
        }));
        const skills = listCompiledSkills();
        const mcpServers = serverStatus().map((s) => ({
          name: s.name,
          connected: Boolean((s as any).connected),
          granted: Boolean((s as any).granted),
          toolsCount: typeof (s as any).toolsCount === 'number' ? (s as any).toolsCount : 0
        }));
        const peers = listAllPeers().map((p) => ({
          name: p.id,
          label: p.label,
          command: p.command
        }));
        const tasks = backgroundTaskManager.list().slice(0, 20).map((t) => ({
          id: t.taskId,
          label: t.label,
          command: t.command,
          status: t.status,
          startedAt: t.startedAt
        }));
        let worktrees: Array<{ path: string; branch: string; managed: boolean }> = [];
        try {
          worktrees = listWorktrees(workspaceRoot).map((w) => ({
            path: w.path,
            branch: w.branch || 'detached',
            managed: Boolean(w.managed)
          }));
        } catch {
          worktrees = [];
        }
        sendJson(res, 200, {
          ok: true,
          commandsCount: listCommands('terminal').length,
          skillsCount: skills.length,
          checkpoints,
          mcpServers,
          peers,
          tasks,
          worktrees,
          browserActive: causyneBrowser({ workspace: workspaceRoot }).isActive(),
          browserControlOwner
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/mcp/browser') {
        res.statusCode = 405;
        res.setHeader('Allow', 'POST');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Use POST for Streamable HTTP MCP JSON-RPC requests.' }));
        return;
      }

      if (req.method === 'POST' && pathname === '/api/mcp/browser') {
        const body = await readJsonBody(req) as JsonRpcMessage;
        const reply = await handleBrowserMcpRpc(body, {
          workspaceRoot,
          version,
          onActivity: (activity) => {
            if (activity.phase === 'start') {
              browserControlOwner = 'agent';
              browserAgentActivity = {
                active: true,
                tool: activity.tool,
                detail: activity.detail,
                updatedAt: Date.now()
              };
            } else {
              browserAgentActivity = { active: false, tool: '', detail: '', updatedAt: Date.now() };
            }
            broadcastBrowserNotice({
              type: 'agent_activity',
              controlOwner: browserControlOwner,
              agentActivity: browserAgentActivity
            });
          }
        });
        if (reply === null) {
          res.statusCode = 202;
          res.end();
          return;
        }
        sendJson(res, 200, reply);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/browser/state') {
        const ensure = parsedUrl.searchParams.get('ensure') === '1';
        const browser = causyneBrowser({ workspace: workspaceRoot });
        const frame = await browser.captureLiveFrame({ ensureStarted: ensure });
        sendJson(res, 200, {
          ok: true,
          controlOwner: browserControlOwner,
          agentActivity: browserAgentActivity,
          computerUsePolicy: 'tiered-approval',
          ...frame
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/browser/stream') {
        const browser = causyneBrowser({ workspace: workspaceRoot });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('X-Accel-Buffering', 'no');
        const writeStreamLine = (payload: Record<string, unknown>): void => {
          if (res.writableEnded || res.destroyed) return;
          try {
            res.write(`${JSON.stringify(payload)}\n`);
          } catch {
            // Stream closed mid-write.
          }
        };
        const unsub = browser.subscribeLiveStream((ev) => {
          writeStreamLine({
            ...ev,
            controlOwner: browserControlOwner,
            agentActivity: browserAgentActivity,
            computerUsePolicy: 'tiered-approval'
          });
        });
        browserStreamClients.add(writeStreamLine);
        writeStreamLine({
          type: 'agent_activity',
          controlOwner: browserControlOwner,
          agentActivity: browserAgentActivity,
          computerUsePolicy: 'tiered-approval'
        });
        const keepAlive = setInterval(() => {
          writeStreamLine({ type: 'ping', ts: Date.now() });
        }, 15_000);
        keepAlive.unref?.();
        const cleanup = (): void => {
          clearInterval(keepAlive);
          browserStreamClients.delete(writeStreamLine);
          unsub();
        };
        req.on('close', cleanup);
        res.on('close', cleanup);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/browser/input') {
        const body = await readJsonBody(req);
        const kind = typeof body.kind === 'string' ? body.kind.trim() : '';
        const allowedKinds = new Set([
          'click', 'dblclick', 'contextmenu', 'mousedown', 'mousemove', 'mouseup', 'wheel', 'type', 'key', 'paste'
        ]);
        if (!allowedKinds.has(kind)) {
          sendJson(res, 400, { error: 'Unsupported live browser input kind.' });
          return;
        }
        browserControlOwner = 'human';
        const browser = causyneBrowser({ workspace: workspaceRoot });
        const result = await browser.dispatchLiveInput({
          kind: kind as LiveBrowserInteraction['kind'],
          x: typeof body.x === 'number' ? body.x : undefined,
          y: typeof body.y === 'number' ? body.y : undefined,
          deltaX: typeof body.deltaX === 'number' ? body.deltaX : undefined,
          deltaY: typeof body.deltaY === 'number' ? body.deltaY : undefined,
          text: typeof body.text === 'string' ? body.text : undefined,
          key: typeof body.key === 'string' ? body.key : undefined,
          button: body.button === 'right' || body.button === 'middle' ? body.button : 'left',
          skipFrame: true
        });
        sendJson(res, 200, { ok: result.ok, controlOwner: browserControlOwner });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/browser/action') {
        const body = await readJsonBody(req);
        const action = typeof body.action === 'string' ? body.action.trim() : '';
        const browser = causyneBrowser({ workspace: workspaceRoot });

        if (action === 'setMode') {
          browserControlOwner = 'human';
          const rawPref = typeof body.enginePreference === 'string' ? body.enginePreference.trim() : '';
          const enginePreference: BrowserEnginePreference | undefined = rawPref === 'camoufox'
            || rawPref === 'chromium'
            || rawPref === 'auto'
            ? rawPref
            : undefined;
          const frame = await browser.setDisplayMode({
            visible: typeof body.visible === 'boolean' ? body.visible : undefined,
            enginePreference,
            ensureStarted: body.ensureStarted === true
          });
          auditLog.log({
            event: 'skybridge_browser_mode_switch',
            visible: frame.visible,
            engine: frame.engine,
            enginePreference: frame.enginePreference
          });
          broadcastBrowserNotice({
            type: 'meta',
            controlOwner: browserControlOwner,
            agentActivity: browserAgentActivity,
            ...frame
          });
          sendJson(res, 200, { ok: true, controlOwner: browserControlOwner, agentActivity: browserAgentActivity, ...frame });
          return;
        }
        if (action === 'takeControl') {
          browserControlOwner = 'human';
          browserAgentActivity = { active: false, tool: '', detail: '', updatedAt: Date.now() };
          const frame = await browser.captureLiveFrame({ ensureStarted: false });
          broadcastBrowserNotice({ type: 'agent_activity', controlOwner: browserControlOwner, agentActivity: browserAgentActivity });
          sendJson(res, 200, { ok: true, controlOwner: browserControlOwner, agentActivity: browserAgentActivity, ...frame });
          return;
        }
        if (action === 'handToAgent') {
          browserControlOwner = 'agent';
          const frame = await browser.captureLiveFrame({ ensureStarted: false });
          broadcastBrowserNotice({ type: 'agent_activity', controlOwner: browserControlOwner, agentActivity: browserAgentActivity });
          sendJson(res, 200, { ok: true, controlOwner: browserControlOwner, agentActivity: browserAgentActivity, ...frame });
          return;
        }
        if (action === 'start') {
          browserControlOwner = 'human';
          const frame = await browser.captureLiveFrame({ ensureStarted: true });
          sendJson(res, 200, { ok: true, controlOwner: browserControlOwner, ...frame });
          return;
        }
        if (action === 'close') {
          await browser.close();
          const frame = await browser.captureLiveFrame({ ensureStarted: false });
          sendJson(res, 200, { ok: true, controlOwner: browserControlOwner, ...frame });
          return;
        }
        if (action === 'goto' || action === 'newTab') {
          browserControlOwner = 'human';
          let rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
          if (rawUrl.startsWith('@')) {
            const idx = rawUrl.indexOf(' ');
            const macro = idx === -1 ? rawUrl : rawUrl.slice(0, idx);
            const q = idx === -1 ? '' : rawUrl.slice(idx + 1).trim();
            const expanded = expandSearchMacro(macro, q);
            if (!expanded) {
              sendJson(res, 400, { error: 'Unsupported browser search macro.' });
              return;
            }
            rawUrl = expanded;
          } else if (rawUrl && !/^https?:\/\//i.test(rawUrl)) {
            rawUrl = rawUrl.includes('.') || rawUrl.startsWith('localhost')
              ? `https://${rawUrl}`
              : (expandSearchMacro('@duckduckgo_search', rawUrl) || `https://duckduckgo.com/?q=${encodeURIComponent(rawUrl)}`);
          }
          await browser.run(
            [action === 'newTab' ? { type: 'newTab', ...(rawUrl ? { url: rawUrl } : {}) } : { type: 'goto', url: rawUrl || 'about:blank' }],
            { workspace: workspaceRoot }
          );
          const frame = await browser.captureLiveFrame({ ensureStarted: true });
          sendJson(res, 200, { ok: true, controlOwner: browserControlOwner, ...frame });
          return;
        }
        if (action === 'back' || action === 'forward' || action === 'reload') {
          browserControlOwner = 'human';
          await browser.run([{ type: action }], { workspace: workspaceRoot });
          const frame = await browser.captureLiveFrame({ ensureStarted: true });
          sendJson(res, 200, { ok: true, controlOwner: browserControlOwner, ...frame });
          return;
        }
        if ((action === 'switchTab' || action === 'closeTab') && typeof body.tabId === 'string' && body.tabId.trim()) {
          browserControlOwner = 'human';
          await browser.run([{ type: action, tabId: body.tabId.trim() }], { workspace: workspaceRoot });
          const frame = await browser.captureLiveFrame({ ensureStarted: true });
          sendJson(res, 200, { ok: true, controlOwner: browserControlOwner, ...frame });
          return;
        }
        if (action === 'viewport') {
          const width = Math.max(320, Math.min(1920, Number(body.width) || 1280));
          const height = Math.max(480, Math.min(1200, Number(body.height) || 800));
          await browser.run([{ type: 'viewport', width, height }], { workspace: workspaceRoot });
          const frame = await browser.captureLiveFrame({ ensureStarted: true });
          sendJson(res, 200, { ok: true, controlOwner: browserControlOwner, ...frame });
          return;
        }
        if (action === 'snapshot') {
          const snap = await browser.snapshot(0);
          const frame = await browser.captureLiveFrame({ ensureStarted: true });
          sendJson(res, 200, {
            ok: true,
            controlOwner: browserControlOwner,
            snapshot: snap.text,
            refsCount: snap.refsCount,
            ...frame
          });
          return;
        }
        if (
          action === 'click'
          || action === 'dblclick'
          || action === 'contextmenu'
          || action === 'mousedown'
          || action === 'mousemove'
          || action === 'mouseup'
          || action === 'wheel'
          || action === 'type'
          || action === 'key'
          || action === 'paste'
        ) {
          browserControlOwner = 'human';
          const frame = await browser.interactAt({
            kind: action,
            x: typeof body.x === 'number' ? body.x : undefined,
            y: typeof body.y === 'number' ? body.y : undefined,
            deltaX: typeof body.deltaX === 'number' ? body.deltaX : undefined,
            deltaY: typeof body.deltaY === 'number' ? body.deltaY : undefined,
            text: typeof body.text === 'string' ? body.text : undefined,
            key: typeof body.key === 'string' ? body.key : undefined,
            button: body.button === 'right' || body.button === 'middle' ? body.button : 'left'
          });
          sendJson(res, 200, { ok: true, controlOwner: browserControlOwner, agentActivity: browserAgentActivity, ...frame });
          return;
        }
        sendJson(res, 400, { error: 'Unsupported shared browser action.' });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/browser/cdp/tabs') {
        const portParam = parsedUrl.searchParams.get('port') || '9222';
        const discovered = await discoverLocalCdpTabs(portParam);
        sendJson(res, 200, {
          ok: true,
          port: discovered.port,
          tabs: discovered.tabs.map((t) => ({ id: t.id, title: t.title, url: t.url }))
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/browser/cdp/sync') {
        const body = await readJsonBody(req);
        const targetId = typeof body.targetId === 'string' ? body.targetId.trim() : '';
        if (!targetId) {
          sendJson(res, 400, { error: 'targetId is required to sync a local browser tab.' });
          return;
        }
        const synced = await syncLocalCdpTabToCausyne({
          workspaceRoot,
          port: body.port ?? 9222,
          targetId,
          includeCookies: body.includeCookies === true
        });
        browserControlOwner = 'human';
        auditLog.log({
          event: 'skybridge_browser_cdp_sync',
          importedCookies: synced.importedCookies
        });
        sendJson(res, 200, {
          ok: true,
          controlOwner: browserControlOwner,
          syncedUrl: synced.syncedUrl,
          importedCookies: synced.importedCookies,
          ...synced.frame
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/browser/import') {
        const body = await readJsonBody(req);
        const rawText = typeof body.rawText === 'string' ? body.rawText : '';
        const summary = await importExplicitUserBrowserData({
          workspaceRoot,
          rawText,
          openFirstUrl: body.openFirstUrl !== false
        });
        const frame = await causyneBrowser({ workspace: workspaceRoot }).captureLiveFrame({ ensureStarted: false });
        auditLog.log({
          event: 'skybridge_browser_import',
          importedCookies: summary.importedCookies,
          urlsCount: summary.importedUrls.length
        });
        sendJson(res, 200, {
          ok: true,
          controlOwner: browserControlOwner,
          ...summary,
          ...frame
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/approve') {
        const body = await readJsonBody(req);
        const toolCallId = typeof body.toolCallId === 'string' ? body.toolCallId.trim() : '';
        const approved = body.approved === true;
        const remember = body.remember === true;
        const toolName = typeof body.tool === 'string' ? body.tool.trim().slice(0, 80) : '';
        if (!toolCallId || !activeLoop?.resolveApproval) {
          sendJson(res, 400, { error: 'No active pending approval matches that toolCallId.' });
          return;
        }
        if (approved && remember && toolName && activeLoop.grantAlways) {
          activeLoop.grantAlways(toolName);
          auditLog.log({ event: 'skybridge_approval_grant_always', tool: toolName });
        }
        activeLoop.resolveApproval(toolCallId, approved);
        sendJson(res, 200, { ok: true, toolCallId, approved, remembered: Boolean(approved && remember && toolName) });
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
        const requestedSessionId = typeof body.sessionId === 'string' && SAFE_SESSION_ID_RE.test(body.sessionId.trim())
          ? body.sessionId.trim()
          : '';
        const providerOverride = typeof body.provider === 'string' && SAFE_PROVIDER_RE.test(body.provider.trim())
          ? body.provider.trim()
          : undefined;
        const modelOverride = typeof body.model === 'string' && SAFE_MODEL_RE.test(body.model.trim())
          ? body.model.trim()
          : undefined;
        if (!prompt) {
          sendJson(res, 400, { error: 'Prompt text is required.' });
          return;
        }

        let boundSession = requestedSessionId ? getSession(requestedSessionId) : null;
        if (boundSession && !workspaceMatchesSession(boundSession.workspace, workspaceRoot)) {
          boundSession = null;
        }
        if (!boundSession && !hasCustomFactory) {
          boundSession = createSession(workspaceRoot, prompt.slice(0, 60), false);
        }

        const { effectivePrompt, attachedPaths } = buildWorkspacePromptWithAttachments(
          workspaceRoot,
          prompt,
          body.attachments
        );

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');

        const taskId = `web-${++taskCounter}-${Date.now()}`;
        let collectedAssistantText = '';
        const writeFrame = (raw: string): void => {
          if (res.writableEnded || res.destroyed) return;
          const clean = raw.replace(/\r?\n/g, ' ');
          try {
            const parsed = JSON.parse(clean) as { type?: string; delta?: string; content?: string };
            if (parsed.type === 'agent_chunk' && typeof parsed.delta === 'string') {
              collectedAssistantText += parsed.delta;
            } else if (parsed.type === 'agent_message' && typeof parsed.content === 'string' && !collectedAssistantText) {
              collectedAssistantText = parsed.content;
            }
          } catch {
            // pass raw frame through untouched
          }
          res.write(`${clean}\n`);
        };
        if (boundSession) {
          writeFrame(JSON.stringify({
            type: 'session_bound',
            sessionId: boundSession.id,
            title: boundSession.title,
            attachments: attachedPaths
          }));
        }

        const sink = { readyState: 1, send: writeFrame };
        const wrappedSink = {
          readyState: 1,
          send: (raw: string) => {
            try {
              const parsed = JSON.parse(raw) as { type?: string; tool?: string; args?: Record<string, unknown> };
              const toolLower = typeof parsed.tool === 'string' ? parsed.tool.toLowerCase() : '';
              const isBrowserTool = toolLower.includes('browser');
              const isComputerTool = toolLower.includes('computer_use') || toolLower.includes('desktop_act');
              if ((parsed.type === 'step_start' || parsed.type === 'tool_start') && (isBrowserTool || isComputerTool)) {
                if (isBrowserTool) browserControlOwner = 'agent';
                const detail = isBrowserTool && Array.isArray(parsed.args?.actions) && parsed.args.actions[0]
                  ? String((parsed.args.actions[0] as Record<string, unknown>).type || 'browser.act')
                  : String(parsed.args?.action || parsed.tool || '');
                browserAgentActivity = {
                  active: true,
                  tool: parsed.tool || 'browser.act',
                  detail: detail.slice(0, 80),
                  updatedAt: Date.now()
                };
                broadcastBrowserNotice({
                  type: 'agent_activity',
                  controlOwner: browserControlOwner,
                  agentActivity: browserAgentActivity
                });
              } else if ((parsed.type === 'step_complete' || parsed.type === 'step_error' || parsed.type === 'tool_complete')
                && (isBrowserTool || isComputerTool)) {
                browserAgentActivity = { active: false, tool: '', detail: '', updatedAt: Date.now() };
                broadcastBrowserNotice({
                  type: 'agent_activity',
                  controlOwner: browserControlOwner,
                  agentActivity: browserAgentActivity
                });
              }
            } catch { /* ignore */ }
            sink.send(raw);
          }
        };
        const loop = loopFactory(wrappedSink, taskId, effectivePrompt, {
          workspaceRoot,
          mode,
          sessionId: boundSession?.id,
          provider: providerOverride,
          model: modelOverride
        });
        activeLoop = loop;
        req.on('close', () => {
          if (activeLoop === loop && !res.writableEnded) {
            loop.abort?.();
          }
        });

        try {
          await loop.run();
          if (boundSession && hasCustomFactory && collectedAssistantText.trim()) {
            const latest = getSession(boundSession.id);
            if (latest) {
              const nextMessages: SessionMessage[] = [
                ...latest.messages,
                { role: 'user', content: prompt },
                { role: 'assistant', content: collectedAssistantText.trim() }
              ];
              saveSessionMessages(boundSession.id, nextMessages);
            }
          }
          writeFrame(JSON.stringify({
            type: 'done',
            taskId,
            sessionId: boundSession?.id || null
          }));
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
