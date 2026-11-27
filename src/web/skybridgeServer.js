import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createApprovalScope } from '../approvalGrants.js';
import { physicalPath } from '../agent/workspaceBoundary.js';
import { auditLog } from '../auditLog.js';
import { getPackageVersion } from '../version.js';
import { redactProviderSecrets } from '../providers/byokHttp.js';
import { closeAll as closeAllMcpServers } from '../mcp/mcpRegistry.js';
import { lspSessionManager } from '../lsp/lspClient.js';
import { backgroundTaskManager } from '../backgroundTasks.js';
import { ptyTerminalManager } from '../tools/ptyTerminal.js';
import { renderSkybridgeHtml, getCausyneFaviconSvg } from './skybridgeUi.js';
import { SAFE_SESSION_ID_RE, applySecurityHeaders, isAllowedSkybridgeHost, isAllowedSkybridgeOrigin, sendJson, timingSafeBearerMatch } from './server/security.js';
import { serveStaticAsset } from './server/staticAssets.js';
import { extractSessionFileEvidence, extractSessionTouchedFiles, normalizeWorkspaceRelCandidate } from './server/sessionTranscript.js';
import { attachRunStream, createDefaultLoopFactory, pushRunFrame } from './server/activeRuns.js';
import { handleCoreRoutes } from './server/routesCore.js';
import { handleWorkspaceRoutes } from './server/routesWorkspace.js';
import { handleBrowserRoutes } from './server/routesBrowser.js';
import { handleTerminalRoutes } from './server/routesTerminal.js';
import { handleChatRoutes } from './server/routesChat.js';
export { extractSessionFileEvidence, extractSessionTouchedFiles, isAllowedSkybridgeHost, isAllowedSkybridgeOrigin };
export async function startSkybridgeServer(options = {}) {
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
    let taskCounter = 0;
    const serverApprovalScope = createApprovalScope();
    const loopFactory = options.loopFactory
        ?? createDefaultLoopFactory(serverApprovalScope, () => boundPort, token);
    const activeRuns = new Map();
    const sessionTouchedFilesMap = new Map();
    const browserStreamClients = new Set();
    let browserControlOwner = 'human';
    let browserAgentActivity = {
        active: false,
        tool: '',
        detail: '',
        updatedAt: 0
    };
    const ctx = {
        workspaceRoot,
        version,
        token,
        hasCustomFactory,
        entitlementClient: options.entitlementClient,
        loopFactory,
        serverApprovalScope,
        activeRuns,
        sessionTouchedFilesMap,
        browserStreamClients,
        getBoundPort: () => boundPort,
        nextTaskId: () => `web-${++taskCounter}-${Date.now()}`,
        findActiveRun: (sessionId) => {
            if (sessionId && activeRuns.has(sessionId))
                return activeRuns.get(sessionId) ?? null;
            if (!sessionId && activeRuns.size === 1)
                return activeRuns.values().next().value ?? null;
            return null;
        },
        pushRunFrame,
        attachRunStream,
        recordSessionTouchedFile: (sessionId, rawPath) => {
            if (!sessionId || !SAFE_SESSION_ID_RE.test(sessionId))
                return;
            const norm = normalizeWorkspaceRelCandidate(workspaceRoot, rawPath);
            if (!norm)
                return;
            let set = sessionTouchedFilesMap.get(sessionId);
            if (!set) {
                set = new Set();
                sessionTouchedFilesMap.set(sessionId, set);
            }
            set.add(norm);
        },
        getBrowserControlOwner: () => browserControlOwner,
        setBrowserControlOwner: (owner) => { browserControlOwner = owner; },
        getBrowserAgentActivity: () => browserAgentActivity,
        setBrowserAgentActivity: (activity) => { browserAgentActivity = activity; },
        broadcastBrowserNotice: (payload) => {
            for (const send of browserStreamClients) {
                try {
                    send(payload);
                }
                catch { /* isolate client write errors */ }
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
        if (req.method === 'GET' && pathname === '/favicon.svg') {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.end(getCausyneFaviconSvg());
            return;
        }
        if (req.method === 'GET' && pathname === '/favicon.ico') {
            res.statusCode = 204;
            res.end();
            return;
        }
        if (req.method === 'GET' && pathname.startsWith('/assets/')) {
            if (serveStaticAsset(pathname, res))
                return;
            sendJson(res, 404, { error: 'Static asset not found.' });
            return;
        }
        if (req.method === 'GET' && pathname === '/') {
            const cspNonce = crypto.randomBytes(16).toString('base64url');
            res.statusCode = 200;
            res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'nonce-${cspNonce}'; `
                + `style-src 'self' 'unsafe-inline'; img-src 'self' data:; `
                + `frame-src http://127.0.0.1:* http://localhost:*; `
                + `connect-src 'self'; frame-ancestors 'none'`);
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
            if (await handleCoreRoutes(req, res, parsedUrl, ctx))
                return;
            if (await handleWorkspaceRoutes(req, res, parsedUrl, ctx))
                return;
            if (await handleBrowserRoutes(req, res, parsedUrl, ctx))
                return;
            if (await handleTerminalRoutes(req, res, parsedUrl, ctx))
                return;
            if (await handleChatRoutes(req, res, parsedUrl, ctx))
                return;
            sendJson(res, 404, { error: 'Unknown Skybridge API endpoint.' });
        }
        catch (err) {
            const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : '';
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
            if (!res.headersSent)
                sendJson(res, status, { error: safeError });
            else if (!res.writableEnded)
                res.end();
        }
    });
    server.requestTimeout = 0;
    server.timeout = 0;
    server.headersTimeout = 60_000;
    server.keepAliveTimeout = 65_000;
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(requestedPort, '127.0.0.1', () => {
            server.off('error', reject);
            const addr = server.address();
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
            for (const run of activeRuns.values()) {
                run.userStopped = true;
                run.loop.abort?.();
                for (const doneCb of [...run.doneSubscribers]) {
                    try {
                        doneCb();
                    }
                    catch { /* ignore */ }
                }
            }
            activeRuns.clear();
            await Promise.race([
                Promise.allSettled([
                    Promise.resolve().then(() => closeAllMcpServers()),
                    Promise.resolve().then(() => lspSessionManager.shutdownAll()),
                    Promise.resolve().then(() => backgroundTaskManager.stopAll()),
                    Promise.resolve().then(() => ptyTerminalManager.closeAll())
                ]),
                new Promise((resolve) => {
                    const timer = setTimeout(resolve, 2500);
                    timer.unref?.();
                })
            ]);
            server.closeAllConnections?.();
            await new Promise((resolve) => server.close(() => resolve()));
        }
    };
}
