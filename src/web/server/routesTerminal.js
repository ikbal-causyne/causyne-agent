import { auditLog } from '../../auditLog.js';
import { listAvailableShells, ptyTerminalManager } from '../../tools/ptyTerminal.js';
import { readJsonBody, sendJson } from './security.js';
const SAFE_TERMINAL_ID_RE = /^term_[0-9]+_[a-f0-9]{8}$/;
const ALLOWED_WEB_SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGTSTP', 'SIGHUP']);
function parseTerminalSessionRoute(pathname) {
    if (!pathname.startsWith('/api/terminal/sessions/'))
        return null;
    const raw = pathname.slice('/api/terminal/sessions/'.length);
    if (!raw || raw.includes('/'))
        return null;
    return SAFE_TERMINAL_ID_RE.test(raw) ? raw : null;
}
export async function handleTerminalRoutes(req, res, parsedUrl, ctx) {
    const pathname = parsedUrl.pathname;
    const { workspaceRoot } = ctx;
    if (req.method === 'GET' && pathname === '/api/terminal/sessions') {
        sendJson(res, 200, {
            ok: true,
            sessions: ptyTerminalManager.listSessions(workspaceRoot),
            shells: listAvailableShells()
        });
        return true;
    }
    if (req.method === 'POST' && pathname === '/api/terminal/sessions') {
        const body = await readJsonBody(req);
        const shell = typeof body.shell === 'string' ? body.shell.trim() : undefined;
        const name = typeof body.name === 'string' ? body.name.trim() : undefined;
        const cols = typeof body.cols === 'number' ? body.cols : undefined;
        const rows = typeof body.rows === 'number' ? body.rows : undefined;
        const session = ptyTerminalManager.openSession({
            workspaceRoot,
            shell,
            name,
            origin: 'user',
            cols,
            rows
        });
        auditLog.log({
            event: 'skybridge_terminal_open',
            terminalId: session.id,
            shell: session.shellLabel,
            transport: session.transport
        });
        sendJson(res, 201, { ok: true, session });
        return true;
    }
    const deleteId = parseTerminalSessionRoute(pathname);
    if (req.method === 'DELETE' && deleteId) {
        const existing = ptyTerminalManager.getSession(deleteId);
        if (!existing || existing.workspaceRoot !== workspaceRoot) {
            sendJson(res, 404, { error: 'Terminal session not found in this workspace.' });
            return true;
        }
        const closed = ptyTerminalManager.closeSession(deleteId);
        sendJson(res, closed ? 200 : 404, { ok: closed, id: deleteId });
        return true;
    }
    if (req.method === 'GET' && pathname === '/api/terminal/stream') {
        const id = (parsedUrl.searchParams.get('id') || '').trim();
        if (!SAFE_TERMINAL_ID_RE.test(id)) {
            sendJson(res, 400, { error: 'Invalid terminal session id.' });
            return true;
        }
        const existing = ptyTerminalManager.getSession(id);
        if (!existing || existing.workspaceRoot !== workspaceRoot) {
            sendJson(res, 404, { error: 'Terminal session not found in this workspace.' });
            return true;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Accel-Buffering', 'no');
        const writeLine = (payload) => {
            if (res.writableEnded || res.destroyed)
                return;
            try {
                res.write(`${JSON.stringify(payload)}\n`);
            }
            catch {
                // Stream closed mid-write
            }
        };
        const unsub = ptyTerminalManager.subscribe(id, (ev) => writeLine(ev), true);
        const keepAlive = setInterval(() => {
            writeLine({ type: 'ping', ts: Date.now() });
        }, 15_000);
        keepAlive.unref?.();
        const cleanup = () => {
            clearInterval(keepAlive);
            unsub();
        };
        req.on('close', cleanup);
        res.on('close', cleanup);
        return true;
    }
    if (req.method === 'POST' && pathname === '/api/terminal/input') {
        const body = await readJsonBody(req);
        const id = typeof body.id === 'string' ? body.id.trim() : '';
        if (!SAFE_TERMINAL_ID_RE.test(id)) {
            sendJson(res, 400, { error: 'Invalid terminal session id.' });
            return true;
        }
        const existing = ptyTerminalManager.getSession(id);
        if (!existing || existing.workspaceRoot !== workspaceRoot) {
            sendJson(res, 404, { error: 'Terminal session not found in this workspace.' });
            return true;
        }
        if (typeof body.cols === 'number' && typeof body.rows === 'number') {
            ptyTerminalManager.resizeSession(id, body.cols, body.rows);
        }
        if (typeof body.data === 'string') {
            const result = ptyTerminalManager.writeInput(id, body.data, {
                actor: 'user',
                typed: body.typed !== false
            });
            if (!result.ok) {
                const safeErr = result.code === 'SESSION_EXITED'
                    ? 'Terminal session has already exited.'
                    : result.code === 'TAKEN_OVER'
                        ? 'Terminal session was taken over by the user.'
                        : 'Unable to write to terminal session.';
                sendJson(res, 400, { ok: false, error: safeErr, code: result.code });
                return true;
            }
            sendJson(res, 200, { ok: true, control: result.control });
            return true;
        }
        sendJson(res, 200, { ok: true, control: existing.control });
        return true;
    }
    if (req.method === 'POST' && pathname === '/api/terminal/signal') {
        const body = await readJsonBody(req);
        const id = typeof body.id === 'string' ? body.id.trim() : '';
        const sig = typeof body.signal === 'string' ? body.signal.trim().toUpperCase() : '';
        if (!SAFE_TERMINAL_ID_RE.test(id)) {
            sendJson(res, 400, { error: 'Invalid terminal session id.' });
            return true;
        }
        if (!ALLOWED_WEB_SIGNALS.has(sig)) {
            sendJson(res, 400, { error: 'Unsupported terminal signal.' });
            return true;
        }
        const existing = ptyTerminalManager.getSession(id);
        if (!existing || existing.workspaceRoot !== workspaceRoot) {
            sendJson(res, 404, { error: 'Terminal session not found in this workspace.' });
            return true;
        }
        const result = ptyTerminalManager.signalSession(id, sig, 'user');
        const safeErr = result.ok
            ? undefined
            : (result.code === 'SESSION_EXITED'
                ? 'Terminal session has already exited.'
                : result.code === 'SIGNAL_DENIED'
                    ? 'Requested signal is not permitted.'
                    : 'Unable to signal terminal session.');
        sendJson(res, result.ok ? 200 : 400, { ok: result.ok, ...(safeErr ? { error: safeErr } : {}) });
        return true;
    }
    return false;
}
