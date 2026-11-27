/**
 * Authenticated loopback-only Direct Core SSE Bridge for Causyne Game.
 *
 * Mirrors Causyne Web GUI (Skybridge): Causyne Game operates as a thin visual
 * shell directly over Causyne Agent's warm in-process core (`AgentLoop`,
 * `mcpRegistry`, `sessionJournal`, and `src/licensing/` entitlement gate).
 *
 * Security invariants:
 * - Binds strictly to `127.0.0.1` on an ephemeral port (never wildcard/LAN).
 * - Requires a 256-bit random Bearer token verified via `crypto.timingSafeEqual`.
 * - Enforces exact loopback `Host` header to defeat DNS rebinding.
 * - Validates every workspace root via `fs.realpathSync` + `isBlockedWorkspaceRoot`.
 * - Accepts stdio-only session-scoped MCP servers validated via `McpClient.validateDefinition`.
 * - Zero hidden daemons: starts with `launchGameStudio()` and shuts down with `stopGameStudio()`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentLoop, type AgentLoopEvent } from '../agentLoop.js';
import { createApprovalScope, type ApprovalScope } from '../approvalGrants.js';
import { loadConfig } from '../config.js';
import { getAvailableProvidersOverview, getLiveAntigravityModels, getModelVariantsForPeer } from '../dynamicCatalogue.js';
import { LICENSE_ENFORCEMENT_ENABLED } from '../licensing/policy.js';
import { McpClient, type McpServerDefinition } from '../mcp/mcpClient.js';
import { registerSessionMcpServers, unregisterSessionMcpServers } from '../mcp/mcpRegistry.js';
import { DEFAULT_MODEL_BY_PROVIDER, MODEL_CATALOGUE, PEER_MODEL_CATALOGUE } from '../modelCatalogue.js';
import { resolveModelVariants } from '../modelVariants.js';
import { isAcpProvider } from '../providers/acp.js';
import { isBlockedWorkspaceRoot } from '../sandboxPolicy.js';
import { createSession, getSession } from '../sessionJournal.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_MCP_SERVERS = 16;
const HEARTBEAT_INTERVAL_MS = 15_000;
const DECISION_TIMEOUT_MS = 5 * 60_000;
const FORBIDDEN_ENV_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface CausyneCoreBridgeHandle {
  url: string;
  origin: string;
  port: number;
  token: string;
  close: () => Promise<void>;
}

interface ActiveCoreTurn {
  turnId: string;
  sessionId: string;
  loop: AgentLoop | null;
  aborted: boolean;
  pendingDecisions: Map<string, {
    resolve: (decision: { optionId: string; label: string } | null) => void;
    timer: NodeJS.Timeout;
  }>;
}

interface CoreSessionState {
  id: string;
  cwd: string;
  approvalScope: ApprovalScope;
}

function readPackageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, '..', '..', 'package.json');
    const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function sendSse(res: ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // Client disconnected.
  }
}

function isAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  const raw = req.headers.authorization;
  if (typeof raw !== 'string' || !raw.startsWith('Bearer ')) return false;
  const provided = raw.slice('Bearer '.length).trim();
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expectedToken, 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

function isAllowedHost(req: IncomingMessage, port: number): boolean {
  const host = String(req.headers.host || '').trim().toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buf.byteLength;
    if (total > MAX_BODY_BYTES) {
      throw Object.assign(new Error('Request body too large'), { status: 413 });
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks, total).toString('utf8').trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('Invalid JSON request body'), { status: 400 });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('Request body must be a JSON object'), { status: 400 });
  }
  return parsed as Record<string, unknown>;
}

function resolveSafeWorkspace(rawCwd: unknown): string {
  if (typeof rawCwd !== 'string' || !rawCwd.trim() || rawCwd.includes('\0')) {
    throw Object.assign(new Error('cwd is required'), { status: 400 });
  }
  let resolved: string;
  try {
    resolved = fs.realpathSync(path.resolve(rawCwd.trim()));
    if (!fs.statSync(resolved).isDirectory()) throw new Error('not a directory');
  } catch {
    throw Object.assign(new Error('cwd is not an accessible directory'), { status: 400 });
  }
  if (isBlockedWorkspaceRoot(resolved)) {
    throw Object.assign(new Error('cwd points to a blocked system directory'), { status: 403 });
  }
  return resolved;
}

function parseStdioMcpServers(raw: unknown, cwd: string): McpServerDefinition[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw Object.assign(new Error('mcpServers must be an array'), { status: 400 });
  }
  if (raw.length > MAX_SESSION_MCP_SERVERS) {
    throw Object.assign(new Error(`Maximum ${MAX_SESSION_MCP_SERVERS} MCP servers exceeded`), { status: 400 });
  }
  const defs: McpServerDefinition[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw Object.assign(new Error('Each MCP server must be an object'), { status: 400 });
    }
    const item = entry as Record<string, unknown>;
    const rawType = typeof item.type === 'string' ? item.type.trim().toLowerCase() : '';
    if (rawType === 'http' || rawType === 'sse' || typeof item.url === 'string') {
      throw Object.assign(new Error('Only stdio MCP servers are accepted by Causyne Core Bridge'), { status: 400 });
    }
    if (typeof item.name !== 'string' || !item.name.trim()) {
      throw Object.assign(new Error('MCP server requires a non-empty name'), { status: 400 });
    }
    if (typeof item.command !== 'string' || !item.command.trim()) {
      throw Object.assign(new Error('MCP server requires a non-empty command'), { status: 400 });
    }
    if (!Array.isArray(item.args) || !item.args.every((a) => typeof a === 'string')) {
      throw Object.assign(new Error('MCP server requires string[] args'), { status: 400 });
    }
    let env: Record<string, string> | undefined;
    if (item.env !== undefined) {
      const mapped = Object.create(null) as Record<string, string>;
      if (Array.isArray(item.env)) {
        for (const pair of item.env) {
          if (!pair || typeof pair !== 'object' || Array.isArray(pair)) {
            throw Object.assign(new Error('MCP env array entries must be { name, value }'), { status: 400 });
          }
          const rec = pair as Record<string, unknown>;
          if (typeof rec.name !== 'string' || !rec.name || typeof rec.value !== 'string') {
            throw Object.assign(new Error('MCP env entries require string name and value'), { status: 400 });
          }
          if (!FORBIDDEN_ENV_KEYS.has(rec.name)) mapped[rec.name] = rec.value;
        }
      } else if (typeof item.env === 'object' && item.env !== null) {
        for (const [k, v] of Object.entries(item.env as Record<string, unknown>)) {
          if (typeof v !== 'string') {
            throw Object.assign(new Error('MCP env values must be strings'), { status: 400 });
          }
          if (!FORBIDDEN_ENV_KEYS.has(k)) mapped[k] = v;
        }
      } else {
        throw Object.assign(new Error('Invalid MCP env shape'), { status: 400 });
      }
      if (Object.keys(mapped).length > 0) env = { ...mapped };
    }
    const def: McpServerDefinition = {
      name: item.name.trim(),
      command: item.command.trim(),
      args: [...item.args],
      cwd,
      ...(env ? { env } : {})
    };
    const problem = McpClient.validateDefinition(def);
    if (problem) {
      throw Object.assign(new Error(`Invalid MCP server "${def.name}": ${problem}`), { status: 400 });
    }
    defs.push(def);
  }
  return defs;
}

function buildModelsPayload(version: string): Record<string, unknown> {
  const config = loadConfig() as Record<string, any>;
  const provider = typeof config.provider === 'string' && config.provider.trim()
    ? config.provider.trim()
    : 'deepseek';
  const configuredModel = typeof config.model === 'string' && config.model.trim()
    ? config.model.trim()
    : (DEFAULT_MODEL_BY_PROVIDER[provider.toLowerCase()] || '');

  const overview = getAvailableProvidersOverview(config);
  const norm = provider.toLowerCase();
  const peerKey = norm.startsWith('acp/') ? norm.slice(4) : norm;

  const seen = new Set<string>();
  const modelIds: string[] = [];
  const add = (id: string) => {
    const clean = id.trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    modelIds.push(clean);
  };
  if (configuredModel) add(configuredModel);
  const peerMatch = overview.acp.find((p) => p.providerKey.toLowerCase() === norm || p.id.toLowerCase() === peerKey);
  if (peerMatch) {
    for (const m of peerMatch.models) add(m);
  }
  const byokMatch = overview.byok.find((p) => p.id.toLowerCase() === norm);
  if (byokMatch) {
    for (const m of byokMatch.models) add(m);
  }
  if (Object.hasOwn(PEER_MODEL_CATALOGUE, peerKey)) {
    for (const m of PEER_MODEL_CATALOGUE[peerKey] ?? []) add(m);
  }
  if (Object.hasOwn(MODEL_CATALOGUE, norm)) {
    for (const m of MODEL_CATALOGUE[norm] ?? []) add(m);
  }

  const liveAgyModels = (norm.includes('antigravity') || norm === 'agy')
    ? getLiveAntigravityModels(config)
    : undefined;

  const models = modelIds.slice(0, 40).map((id) => {
    const peerModelVariants = isAcpProvider(provider) ? getModelVariantsForPeer(provider, id, config) : undefined;
    const spec = resolveModelVariants({
      provider,
      model: id,
      currentVariant: typeof config.reasoningEffort === 'string' ? config.reasoningEffort : null,
      peerModelVariants,
      availableAgyModels: liveAgyModels && liveAgyModels.length > 0 ? liveAgyModels : undefined
    });
    const reasoningLevels = spec.supported ? spec.options.map((o) => o.id) : [];
    return {
      id,
      label: id,
      ...(reasoningLevels.length > 0 ? { reasoningLevels } : {}),
      ...(spec.defaultVariant ? { defaultReasoning: spec.defaultVariant } : {})
    };
  });

  return {
    ok: true,
    agent: 'causyne',
    version,
    provider,
    currentModel: configuredModel || modelIds[0] || undefined,
    models
  };
}

const MODELS_CACHE_TTL_MS = 30_000;

export async function startCausyneCoreBridge(): Promise<CausyneCoreBridgeHandle> {
  const token = crypto.randomBytes(32).toString('hex');
  const version = readPackageVersion();
  const sessions = new Map<string, CoreSessionState>();
  const activeTurns = new Map<string, ActiveCoreTurn>();
  let boundPort = 0;
  let cachedModels: { payload: Record<string, unknown>; expiresAt: number } | null = null;

  const getModelsPayload = (forceRefresh: boolean): Record<string, unknown> => {
    const now = Date.now();
    if (!forceRefresh && cachedModels && now < cachedModels.expiresAt) {
      return cachedModels.payload;
    }
    const payload = buildModelsPayload(version);
    cachedModels = { payload, expiresAt: now + MODELS_CACHE_TTL_MS };
    return payload;
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      if (!isAllowedHost(req, boundPort)) {
        sendJson(res, 403, { ok: false, error: 'Invalid Host header' });
        return;
      }
      if (!isAuthorized(req, token)) {
        sendJson(res, 401, { ok: false, error: 'Unauthorized' });
        return;
      }

      const parsedUrl = new URL(req.url || '/', `http://127.0.0.1:${boundPort}`);
      const pathname = parsedUrl.pathname;

      if (req.method === 'GET' && pathname === '/v1/health') {
        sendJson(res, 200, {
          ok: true,
          agent: 'causyne',
          version,
          mode: 'direct-core',
          licensingEnforced: LICENSE_ENFORCEMENT_ENABLED,
          activeTurns: activeTurns.size
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/v1/models') {
        const forceRefresh = parsedUrl.searchParams.get('refresh') === '1';
        sendJson(res, 200, getModelsPayload(forceRefresh));
        return;
      }

      if (req.method === 'POST' && pathname === '/v1/cancel') {
        const body = await readJsonBody(req);
        const turnId = typeof body.turnId === 'string' ? body.turnId.trim() : '';
        const active = turnId ? activeTurns.get(turnId) : undefined;
        if (!active) {
          sendJson(res, 200, { ok: true, cancelled: false });
          return;
        }
        active.aborted = true;
        for (const pending of active.pendingDecisions.values()) {
          clearTimeout(pending.timer);
          pending.resolve(null);
        }
        active.pendingDecisions.clear();
        try { active.loop?.abort(); } catch { /* best-effort */ }
        sendJson(res, 200, { ok: true, cancelled: true });
        return;
      }

      if (req.method === 'POST' && pathname === '/v1/decision') {
        const body = await readJsonBody(req);
        const turnId = typeof body.turnId === 'string' ? body.turnId.trim() : '';
        const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
        const approved = body.approved === true;
        const active = turnId ? activeTurns.get(turnId) : undefined;
        const pending = active?.pendingDecisions.get(requestId);
        if (!active || !pending) {
          sendJson(res, 404, { ok: false, error: 'No pending decision found' });
          return;
        }
        active.pendingDecisions.delete(requestId);
        clearTimeout(pending.timer);
        pending.resolve(approved
          ? { optionId: 'allow_once', label: 'Allow once' }
          : { optionId: 'reject_once', label: 'Deny' });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && pathname === '/v1/turn') {
        const body = await readJsonBody(req);
        const cwd = resolveSafeWorkspace(body.cwd);
        const prompt = typeof body.prompt === 'string' ? body.prompt : '';
        if (!prompt.trim() || Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
          sendJson(res, 400, { ok: false, error: 'prompt must be non-empty and under 2 MiB' });
          return;
        }
        const instructions = typeof body.instructions === 'string' && body.instructions.trim()
          ? body.instructions.trim()
          : undefined;
        const model = typeof body.model === 'string' && body.model.trim() && body.model.trim() !== 'default'
          ? body.model.trim()
          : undefined;
        const reasoning = typeof body.reasoning === 'string' && body.reasoning.trim() && body.reasoning.trim() !== 'default'
          ? body.reasoning.trim()
          : undefined;
        const permissionMode = typeof body.permissionMode === 'string' ? body.permissionMode.trim().toLowerCase() : 'auto';
        const requestedThreadId = typeof body.threadId === 'string' && body.threadId.trim()
          ? body.threadId.trim()
          : undefined;
        const mcpDefs = parseStdioMcpServers(body.mcpServers, cwd);

        let sessionState = requestedThreadId ? sessions.get(requestedThreadId) : undefined;
        if (!sessionState) {
          const existingRecord = requestedThreadId ? getSession(requestedThreadId) : null;
          const record = existingRecord ?? createSession(cwd, prompt.slice(0, 80), false);
          sessionState = {
            id: record.id,
            cwd,
            approvalScope: createApprovalScope()
          };
          sessions.set(sessionState.id, sessionState);
        }

        const turnId = `core-${crypto.randomUUID()}`;
        const turn: ActiveCoreTurn = {
          turnId,
          sessionId: sessionState.id,
          loop: null,
          aborted: false,
          pendingDecisions: new Map()
        };
        activeTurns.set(turnId, turn);

        const mcpRegistrationKey = `${sessionState.id}:${turnId}`;
        if (mcpDefs.length > 0) {
          registerSessionMcpServers(mcpRegistrationKey, mcpDefs);
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Content-Type-Options': 'nosniff'
        });
        res.flushHeaders?.();
        sendSse(res, 'thread', { threadId: sessionState.id, turnId });
        sendSse(res, 'status', { phase: 'thinking', label: 'Causyne Agent' });

        const heartbeat = setInterval(() => {
          if (!res.writableEnded && !res.destroyed) {
            try { res.write(': keepalive\n\n'); } catch { /* ignore */ }
          }
        }, HEARTBEAT_INTERVAL_MS);
        heartbeat.unref?.();

        const onClientClose = () => {
          if (turn.aborted) return;
          turn.aborted = true;
          for (const pending of turn.pendingDecisions.values()) {
            clearTimeout(pending.timer);
            pending.resolve(null);
          }
          turn.pendingDecisions.clear();
          try { turn.loop?.abort(); } catch { /* ignore */ }
        };
        req.once('close', onClientClose);

        let lastAssistantStreamKey = '';
        let lastAssistantText = '';
        let lastReasoningText = '';
        let failed = false;
        let lastErrorMessage = '';

        const sink = {
          readyState: 1,
          send: (rawPayload: string) => {
            if (turn.aborted || res.writableEnded) return;
            let event: AgentLoopEvent;
            try {
              event = JSON.parse(rawPayload) as AgentLoopEvent;
            } catch {
              return;
            }
            if (!event || typeof event !== 'object' || typeof event.type !== 'string') return;
            switch (event.type) {
              case 'agent_message': {
                const text = String(event.content ?? '');
                const key = typeof event.streamId === 'number' || typeof event.streamId === 'string'
                  ? String(event.streamId)
                  : '';
                const sameStream = (Boolean(key) || event.streaming === true) && key === lastAssistantStreamKey;
                const delta = sameStream && text.startsWith(lastAssistantText)
                  ? text.slice(lastAssistantText.length)
                  : text;
                lastAssistantStreamKey = key;
                lastAssistantText = text;
                if (delta) sendSse(res, 'message_delta', { id: key || `msg-${turnId}`, delta });
                if (event.streaming !== true && text) {
                  sendSse(res, 'message_complete', { id: key || `msg-${turnId}`, text });
                  lastAssistantText = '';
                }
                return;
              }
              case 'agent_reasoning': {
                const text = String(event.content ?? '');
                const delta = text.startsWith(lastReasoningText) ? text.slice(lastReasoningText.length) : text;
                lastReasoningText = event.streaming === true ? text : '';
                if (delta) sendSse(res, 'reasoning_delta', { id: `reason-${turnId}`, delta });
                if (event.streaming !== true && text) {
                  sendSse(res, 'reasoning_complete', { id: `reason-${turnId}`, text });
                }
                return;
              }
              case 'status':
              case 'notice': {
                const label = String(event.message ?? '').trim();
                if (label) sendSse(res, 'status', { phase: 'thinking', label });
                return;
              }
              case 'step_start': {
                const callId = String(event.toolCallId ?? `tool-${crypto.randomUUID().slice(0, 8)}`);
                const tool = String(event.tool ?? 'tool');
                sendSse(res, 'tool_start', {
                  callId,
                  tool,
                  args: event.args && typeof event.args === 'object' ? event.args : {}
                });
                return;
              }
              case 'step_end':
              case 'step_error': {
                const callId = String(event.toolCallId ?? `tool-${crypto.randomUUID().slice(0, 8)}`);
                const tool = String(event.tool ?? 'tool');
                const ok = event.type === 'step_end' && event.success !== false;
                sendSse(res, 'tool_end', {
                  callId,
                  tool,
                  status: ok ? 'completed' : 'failed',
                  result: event.result ?? event.output,
                  error: event.error ? String(event.error) : undefined,
                  args: event.args && typeof event.args === 'object' ? event.args : undefined
                });
                return;
              }
              case 'plan_update': {
                if (Array.isArray(event.plan)) {
                  sendSse(res, 'plan', { entries: event.plan });
                }
                return;
              }
              case 'usage':
              case 'token_usage': {
                sendSse(res, 'usage', {
                  inputTokens: typeof event.inputTokens === 'number' ? event.inputTokens : undefined,
                  outputTokens: typeof event.outputTokens === 'number' ? event.outputTokens : undefined,
                  totalTokens: typeof event.totalTokens === 'number' ? event.totalTokens : undefined
                });
                return;
              }
              case 'error': {
                failed = true;
                lastErrorMessage = String(event.message ?? 'Causyne Core execution failed');
                sendSse(res, 'error', { message: lastErrorMessage });
                return;
              }
              default:
                return;
            }
          }
        };

        const peerMcpServers = mcpDefs
          .filter((def): def is McpServerDefinition & { command: string } => typeof def.command === 'string' && def.command.length > 0)
          .map((def) => ({
            name: def.name,
            command: def.command,
            args: Array.isArray(def.args) ? [...def.args] : [],
            env: Object.entries(def.env ?? {}).map(([name, value]) => ({ name, value }))
          }));

        try {
          const loop = new AgentLoop(sink, turnId, prompt, {
            workspaceRoot: cwd,
            memorySessionId: sessionState.id,
            approvalScope: sessionState.approvalScope,
            ...(model ? { model } : {}),
            ...(reasoning ? { variant: reasoning } : {}),
            ...(instructions ? { hostSystemInstructions: instructions } : {}),
            ...(peerMcpServers.length > 0 ? { peerMcpServers } : {})
          });
          const autonomy = permissionMode === 'auto' ? 'C' : (permissionMode === 'ask' ? 'A' : 'B');
          try { loop.setAutonomyMode(autonomy); } catch { /* keep configured mode */ }

          loop.waitForDecision = (request: unknown) => {
            if (turn.aborted || res.writableEnded) return Promise.resolve(null);
            const rec = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
            const requestId = typeof rec.id === 'string' && rec.id ? rec.id : crypto.randomUUID();
            const title = typeof rec.question === 'string' ? rec.question.slice(0, 300) : 'Approval required';
            const detail = typeof rec.detail === 'string' ? rec.detail.slice(0, 1200) : '';
            const kind = typeof rec.kind === 'string' ? rec.kind : 'other';
            return new Promise<{ optionId: string; label: string } | null>((resolve) => {
              const timer = setTimeout(() => {
                turn.pendingDecisions.delete(requestId);
                resolve(null);
              }, DECISION_TIMEOUT_MS);
              timer.unref?.();
              turn.pendingDecisions.set(requestId, { resolve, timer });
              sendSse(res, 'approval_request', { turnId, requestId, kind, title, detail });
            });
          };

          turn.loop = loop;
          await loop.run();
          if (!turn.aborted) {
            sendSse(res, 'done', {
              ok: !failed,
              stopReason: failed ? 'error' : 'end_turn',
              ...(failed && lastErrorMessage ? { error: lastErrorMessage } : {})
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!turn.aborted) {
            sendSse(res, 'error', { message: msg });
            sendSse(res, 'done', { ok: false, stopReason: 'error', error: msg });
          }
        } finally {
          clearInterval(heartbeat);
          req.off('close', onClientClose);
          for (const pending of turn.pendingDecisions.values()) {
            clearTimeout(pending.timer);
            pending.resolve(null);
          }
          turn.pendingDecisions.clear();
          turn.loop = null;
          activeTurns.delete(turnId);
          await unregisterSessionMcpServers(mcpRegistrationKey).catch(() => {});
          if (!res.writableEnded) res.end();
        }
        return;
      }

      sendJson(res, 404, { ok: false, error: 'Not found' });
    })().catch((err: unknown) => {
      const status = typeof (err as { status?: unknown })?.status === 'number'
        ? (err as { status: number }).status
        : 500;
      const safeError = status === 413
        ? 'Request body too large'
        : status === 400
          ? 'Invalid JSON request body'
          : status === 403
            ? 'Forbidden'
            : status === 404
              ? 'Not found'
              : 'Internal bridge error';
      sendJson(res, status, {
        ok: false,
        error: safeError
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const addr = server.address();
      if (!addr || typeof addr !== 'object') {
        reject(new Error('Failed to bind Causyne Core Bridge on 127.0.0.1'));
        return;
      }
      boundPort = addr.port;
      resolve();
    });
  });

  const warmupTimer = setTimeout(() => {
    try { getModelsPayload(false); } catch { /* best-effort warmup */ }
  }, 50);
  warmupTimer.unref();

  const origin = `http://127.0.0.1:${boundPort}`;
  return {
    url: origin,
    origin,
    port: boundPort,
    token,
    close: async () => {
      clearTimeout(warmupTimer);
      for (const turn of activeTurns.values()) {
        turn.aborted = true;
        for (const pending of turn.pendingDecisions.values()) {
          clearTimeout(pending.timer);
          pending.resolve(null);
        }
        turn.pendingDecisions.clear();
        try { turn.loop?.abort(); } catch { /* ignore */ }
      }
      activeTurns.clear();
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    }
  };
}
