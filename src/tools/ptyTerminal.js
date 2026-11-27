/**
 * Causyne Agent — Interactive Workspace PTY Terminal Manager & Tool
 *
 * Zero-dependency, OS-sandboxed interactive pseudo-terminal manager supporting:
 *   - Real POSIX PTY sessions via Python `pty.fork()` + `TIOCSWINSZ` (zero native
 *     `postinstall` binary requirement) with transparent fallback to piped shell.
 *   - Regex-free character-scanning ANSI/CSI/OSC stream sanitizer (immune to ReDoS)
 *     plus OSC 133;D prompt-completion marker detection.
 *   - Bounded scrollback ring buffer, live NDJSON subscribers for Skybridge Studio,
 *     atomic `agent -> user` takeover semantics, and foreground process-group signaling.
 */
import { spawn, spawnSync, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { getEnhancedEnv } from './sysRun.js';
import { redactTextSecrets } from '../providers/byokHttp.js';
import { resolveOsSandboxMode, wrapCommandWithOsSandbox } from './osSandbox.js';
import { boundedInteger, getErrorMessage, resolveScopedPath, resolveToolWorkspaceRoots, sanitizeToolError } from './toolPathSafety.js';
const MAX_PTY_SESSIONS = 10;
const MAX_SCROLLBACK_CHARS = 256 * 1024;
const ALLOWED_SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGTSTP', 'SIGHUP', 'SIGKILL']);
const ALLOWED_POSIX_SHELLS = [
    { id: 'zsh', label: 'zsh', path: '/bin/zsh' },
    { id: 'bash', label: 'bash', path: '/bin/bash' },
    { id: 'sh', label: 'sh', path: '/bin/sh' },
    { id: 'usr-zsh', label: 'zsh', path: '/usr/bin/zsh' },
    { id: 'usr-bash', label: 'bash', path: '/usr/bin/bash' },
    { id: 'local-zsh', label: 'zsh', path: '/usr/local/bin/zsh' },
    { id: 'local-bash', label: 'bash', path: '/usr/local/bin/bash' },
    { id: 'opt-zsh', label: 'zsh', path: '/opt/homebrew/bin/zsh' },
    { id: 'opt-bash', label: 'bash', path: '/opt/homebrew/bin/bash' }
];
const ALLOWED_POSIX_SHELL_PATH_SET = new Set(ALLOWED_POSIX_SHELLS.map((s) => s.path));
const PYTHON_PTY_HELPER = `
import base64, errno, fcntl, json, os, pty, select, signal, struct, subprocess, sys, termios

shell = sys.argv[1]
cols = max(20, min(400, int(sys.argv[2])))
rows = max(6, min(160, int(sys.argv[3])))

def emit(obj):
    sys.stdout.write(json.dumps(obj, separators=(',', ':')) + '\\n')
    sys.stdout.flush()

use_pty = True
proc = None
pid = None
master_fd = None
pipe_in_fd = None
pipe_out_fd = None

try:
    pid, master_fd = pty.fork()
    if pid == 0:
        try:
            os.execv(shell, [shell, '-i'])
        except Exception:
            try:
                os.execv(shell, [shell])
            except Exception:
                os._exit(127)
except OSError:
    use_pty = False
    proc = subprocess.Popen(
        [shell],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    pid = proc.pid
    pipe_in_fd = proc.stdin.fileno()
    pipe_out_fd = proc.stdout.fileno()

def set_size(r, c):
    if not use_pty or master_fd is None:
        return
    try:
        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
        try:
            os.killpg(pid, signal.SIGWINCH)
        except Exception:
            pass
    except Exception:
        pass

read_fd = master_fd if use_pty else pipe_out_fd
write_fd = master_fd if use_pty else pipe_in_fd

set_size(rows, cols)
os.set_blocking(read_fd, False)
emit({'t': 'ready', 'pid': pid, 'mode': 'pty' if use_pty else 'pipe'})

stdin_fd = sys.stdin.fileno()
os.set_blocking(stdin_fd, False)
cmd_buf = b''
stdin_open = True
exit_code = None

sig_map = {
    'SIGINT': signal.SIGINT,
    'SIGTERM': signal.SIGTERM,
    'SIGTSTP': signal.SIGTSTP,
    'SIGHUP': signal.SIGHUP,
    'SIGKILL': signal.SIGKILL,
}

def drain_out():
    while True:
        try:
            chunk = os.read(read_fd, 16384)
            if not chunk:
                return False
            emit({'t': 'out', 'b': base64.b64encode(chunk).decode('ascii')})
        except BlockingIOError:
            return True
        except OSError as e:
            if e.errno in (errno.EIO, errno.EBADF):
                return False
            return True

while True:
    rlist = [read_fd]
    if stdin_open:
        rlist.append(stdin_fd)
    try:
        ready, _, _ = select.select(rlist, [], [], 0.2)
    except (InterruptedError, ValueError):
        ready = []
    if read_fd in ready:
        if not drain_out():
            break
    if stdin_fd in ready:
        try:
            raw = os.read(stdin_fd, 16384)
            if not raw:
                stdin_open = False
                try:
                    os.killpg(pid, signal.SIGHUP)
                except Exception:
                    pass
                break
            cmd_buf += raw
            while b'\\n' in cmd_buf:
                line, cmd_buf = cmd_buf.split(b'\\n', 1)
                if not line:
                    continue
                try:
                    msg = json.loads(line.decode('utf-8', 'replace'))
                except Exception:
                    continue
                kind = msg.get('t')
                if kind == 'in':
                    data = base64.b64decode(msg.get('b', ''))
                    if data:
                        try:
                            os.write(write_fd, data)
                        except OSError:
                            pass
                elif kind == 'resize':
                    r = max(6, min(160, int(msg.get('rows', rows))))
                    c = max(20, min(400, int(msg.get('cols', cols))))
                    rows, cols = r, c
                    set_size(rows, cols)
                elif kind == 'sig':
                    sname = msg.get('s')
                    sig = sig_map.get(sname)
                    if sig is not None:
                        try:
                            if use_pty and master_fd is not None:
                                fg = os.tcgetpgrp(master_fd)
                                os.killpg(fg if fg > 0 else pid, sig)
                            else:
                                os.killpg(pid, sig)
                        except Exception:
                            try:
                                os.killpg(pid, sig)
                            except Exception:
                                pass
                elif kind == 'close':
                    try:
                        os.killpg(pid, signal.SIGTERM)
                    except Exception:
                        pass
                    stdin_open = False
                    break
        except BlockingIOError:
            pass
        except OSError:
            stdin_open = False
            break
    if use_pty:
        try:
            wpid, status = os.waitpid(pid, os.WNOHANG)
            if wpid == pid:
                drain_out()
                if os.WIFEXITED(status):
                    exit_code = os.WEXITSTATUS(status)
                elif os.WIFSIGNALED(status):
                    exit_code = 128 + os.WTERMSIG(status)
                else:
                    exit_code = 0
                break
        except ChildProcessError:
            exit_code = 0
            break
    else:
        rc = proc.poll()
        if rc is not None:
            drain_out()
            exit_code = rc
            break

if use_pty and master_fd is not None:
    try:
        os.close(master_fd)
    except Exception:
        pass
elif proc is not None:
    try:
        proc.stdin.close()
    except Exception:
        pass
    try:
        proc.stdout.close()
    except Exception:
        pass

if exit_code is None:
    exit_code = 0

emit({'t': 'exit', 'code': exit_code})
`;
/**
 * Pure character-scanning terminal escape sanitizer (zero regular expressions).
 * Strips CSI, OSC, DCS, and C1 control sequences across arbitrary chunk boundaries,
 * while surfacing OSC 133;D prompt-completion markers for exact readiness detection.
 */
export class TerminalSanitizer {
    mode = 'text';
    oscBuf = '';
    process(chunk) {
        let out = '';
        let promptMarkers = 0;
        for (let i = 0; i < chunk.length; i++) {
            const ch = chunk[i];
            const code = chunk.charCodeAt(i);
            if (this.mode === 'text') {
                if (code === 0x1b) {
                    this.mode = 'esc';
                }
                else if (code === 0x0d) {
                    // Drop bare CR so \r\n normalizes to \n without overwriting visible text
                }
                else if (code === 0x08) {
                    if (out.length > 0 && out[out.length - 1] !== '\n') {
                        out = out.slice(0, -1);
                    }
                }
                else if (code === 0x09 || code === 0x0a || code >= 0x20) {
                    out += ch;
                }
                continue;
            }
            if (this.mode === 'esc') {
                if (ch === '[') {
                    this.mode = 'csi';
                }
                else if (ch === ']') {
                    this.mode = 'osc';
                    this.oscBuf = '';
                }
                else if (ch === 'P' || ch === '_' || ch === '^' || ch === 'X') {
                    this.mode = 'st_skip';
                }
                else if (ch === '(' || ch === ')' || ch === '*' || ch === '+') {
                    // Character-set designation consumes one following char
                    if (i + 1 < chunk.length)
                        i++;
                    this.mode = 'text';
                }
                else {
                    this.mode = 'text';
                }
                continue;
            }
            if (this.mode === 'csi') {
                if (code >= 0x40 && code <= 0x7e) {
                    this.mode = 'text';
                }
                continue;
            }
            if (this.mode === 'osc') {
                if (code === 0x07) {
                    if (this.oscBuf.startsWith('133;D'))
                        promptMarkers++;
                    this.oscBuf = '';
                    this.mode = 'text';
                }
                else if (code === 0x1b) {
                    this.mode = 'osc_esc';
                }
                else if (this.oscBuf.length < 256) {
                    this.oscBuf += ch;
                }
                continue;
            }
            if (this.mode === 'osc_esc') {
                if (ch === '\\') {
                    if (this.oscBuf.startsWith('133;D'))
                        promptMarkers++;
                    this.oscBuf = '';
                    this.mode = 'text';
                }
                else {
                    this.oscBuf = '';
                    this.mode = 'text';
                }
                continue;
            }
            if (this.mode === 'st_skip') {
                if (code === 0x1b)
                    this.mode = 'st_esc';
                continue;
            }
            if (this.mode === 'st_esc') {
                this.mode = ch === '\\' ? 'text' : 'st_skip';
            }
        }
        return { text: out, promptMarkers };
    }
}
let cachedPython3Path;
function resolvePython3Path() {
    if (cachedPython3Path !== undefined)
        return cachedPython3Path;
    if (process.platform === 'win32') {
        cachedPython3Path = null;
        return null;
    }
    const candidates = ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3', 'python3'];
    for (const bin of candidates) {
        try {
            const res = spawnSync(bin, ['-c', 'import pty, fcntl, termios; print("ok")'], {
                encoding: 'utf8',
                timeout: 2500,
                stdio: ['ignore', 'pipe', 'ignore']
            });
            if (res.status === 0 && (res.stdout || '').trim() === 'ok') {
                cachedPython3Path = bin;
                return bin;
            }
        }
        catch {
            // Try next candidate
        }
    }
    cachedPython3Path = null;
    return null;
}
export function listAvailableShells() {
    if (process.platform === 'win32') {
        return [
            { id: 'powershell', label: 'PowerShell', path: 'powershell.exe', isDefault: true },
            { id: 'cmd', label: 'cmd', path: 'cmd.exe', isDefault: false }
        ];
    }
    const envShell = (process.env.SHELL || '').trim();
    const seenLabels = new Set();
    const shells = [];
    const pushIfExists = (shellPath, label, id) => {
        if (!ALLOWED_POSIX_SHELL_PATH_SET.has(shellPath))
            return;
        if (!fs.existsSync(shellPath))
            return;
        if (seenLabels.has(label))
            return;
        seenLabels.add(label);
        shells.push({
            id,
            label,
            path: shellPath,
            isDefault: shellPath === envShell
        });
    };
    if (envShell && ALLOWED_POSIX_SHELL_PATH_SET.has(envShell)) {
        const match = ALLOWED_POSIX_SHELLS.find((s) => s.path === envShell);
        if (match)
            pushIfExists(match.path, match.label, match.id);
    }
    for (const entry of ALLOWED_POSIX_SHELLS) {
        pushIfExists(entry.path, entry.label, entry.id);
    }
    if (shells.length > 0 && !shells.some((s) => s.isDefault)) {
        shells[0].isDefault = true;
    }
    return shells;
}
function resolveRequestedShell(rawShell) {
    const available = listAvailableShells();
    const fallback = available.find((s) => s.isDefault) ?? available[0] ?? {
        path: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
        label: process.platform === 'win32' ? 'PowerShell' : 'sh'
    };
    if (typeof rawShell !== 'string' || !rawShell.trim()) {
        return { path: fallback.path, label: fallback.label };
    }
    const q = rawShell.trim().toLowerCase();
    const matched = available.find((s) => s.id.toLowerCase() === q || s.label.toLowerCase() === q || s.path.toLowerCase() === q);
    if (matched)
        return { path: matched.path, label: matched.label };
    return { path: fallback.path, label: fallback.label };
}
function trimScrollback(text) {
    if (text.length <= MAX_SCROLLBACK_CHARS)
        return text;
    let cut = text.length - MAX_SCROLLBACK_CHARS;
    // Preserve UTF-16 surrogate pair boundary
    const code = text.charCodeAt(cut);
    if (code >= 0xdc00 && code <= 0xdfff && cut + 1 < text.length) {
        cut += 1;
    }
    return text.slice(cut);
}
function terminateChildTree(proc, detachedGroup, force = false) {
    const pid = proc.pid;
    try {
        proc.stdin?.end();
    }
    catch { /* ignore */ }
    if (!pid)
        return;
    if (process.platform === 'win32') {
        try {
            if (force) {
                spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 2000 });
            }
            else {
                execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 4000 }, () => { });
            }
        }
        catch { /* ignore */ }
        try {
            proc.kill();
        }
        catch { /* ignore */ }
        return;
    }
    const sig = force ? 'SIGKILL' : 'SIGTERM';
    if (detachedGroup) {
        try {
            process.kill(-pid, sig);
            return;
        }
        catch { /* fallback */ }
    }
    try {
        proc.kill(sig);
    }
    catch { /* ignore */ }
}
export class PtyTerminalManager {
    sessions = new Map();
    counter = 0;
    listSessions(workspaceRoot) {
        const out = [];
        for (const session of this.sessions.values()) {
            if (workspaceRoot && session.workspaceRoot !== workspaceRoot)
                continue;
            out.push(this.toSummary(session));
        }
        return out.sort((a, b) => a.createdAt - b.createdAt);
    }
    getSession(id) {
        const session = this.sessions.get(id);
        return session ? this.toSummary(session) : null;
    }
    openSession(options) {
        const runningCount = [...this.sessions.values()].filter((s) => s.status === 'running').length;
        if (runningCount >= MAX_PTY_SESSIONS) {
            throw new Error(`Maximum concurrent terminal sessions (${MAX_PTY_SESSIONS}) reached. Close an existing terminal first.`);
        }
        const scopeCtx = { workspaceRoot: options.workspaceRoot, workspacePaths: [options.workspaceRoot] };
        const resolvedCwd = typeof options.cwd === 'string' && options.cwd.trim()
            ? resolveScopedPath(options.cwd, scopeCtx)
            : options.workspaceRoot;
        const chosenShell = resolveRequestedShell(options.shell);
        const cols = boundedInteger(options.cols, 100, 20, 400);
        const rows = boundedInteger(options.rows, 28, 6, 160);
        const origin = options.origin === 'agent' ? 'agent' : 'user';
        const control = origin;
        const id = `term_${++this.counter}_${crypto.randomBytes(4).toString('hex')}`;
        const name = typeof options.name === 'string' && options.name.trim()
            ? options.name.trim().slice(0, 48)
            : `${chosenShell.label} #${this.counter}`;
        const python3 = resolvePython3Path();
        const usePty = Boolean(python3 && process.platform !== 'win32');
        const baseCommand = usePty ? python3 : chosenShell.path;
        const baseArgs = usePty
            ? ['-u', '-c', PYTHON_PTY_HELPER, chosenShell.path, String(cols), String(rows)]
            : (process.platform === 'win32' && chosenShell.path.toLowerCase().includes('powershell')
                ? ['-NoLogo', '-NoProfile', '-NoExit', '-Command', '-']
                : []);
        const workspaceRoots = [options.workspaceRoot];
        let wrapped;
        if (options.osSandbox && typeof options.osSandbox === 'object') {
            wrapped = wrapCommandWithOsSandbox(baseCommand, baseArgs, {
                ...options.osSandbox,
                cwd: options.osSandbox.cwd || resolvedCwd,
                workspaceRoots: options.osSandbox.workspaceRoots || workspaceRoots
            });
        }
        else {
            const sandboxRes = resolveOsSandboxMode(process.env, typeof options.osSandbox === 'string' ? options.osSandbox : undefined);
            wrapped = wrapCommandWithOsSandbox(baseCommand, baseArgs, {
                mode: sandboxRes.mode,
                strict: sandboxRes.strict,
                allowNetwork: sandboxRes.allowNetwork,
                cwd: resolvedCwd,
                workspaceRoots
            });
        }
        const baseEnv = getEnhancedEnv();
        const env = {
            ...baseEnv,
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            COLUMNS: String(cols),
            LINES: String(rows),
            CAUSYNE_TERMINAL: '1',
            // OSC 133;D marker for exact prompt-completion readiness in bash/zsh
            PROMPT_COMMAND: 'printf "\\033]133;D;%s\\007" "$?"'
        };
        const detachedGroup = process.platform !== 'win32';
        const proc = spawn(wrapped.command, wrapped.args, {
            cwd: resolvedCwd,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: detachedGroup,
            windowsHide: true
        });
        const now = Date.now();
        const session = {
            id,
            name,
            shell: chosenShell.path,
            shellLabel: chosenShell.label,
            cwd: resolvedCwd,
            workspaceRoot: options.workspaceRoot,
            origin,
            control,
            transport: usePty ? 'pty' : 'pipe',
            proc,
            detachedGroup,
            childPid: proc.pid ?? null,
            status: 'running',
            exitCode: null,
            cols,
            rows,
            createdAt: now,
            lastActivityAt: now,
            scrollback: '',
            sanitizer: new TerminalSanitizer(),
            promptMarkerCount: 0,
            stdoutLineBuf: '',
            subscribers: new Set()
        };
        const appendOutput = (rawChunk) => {
            const cleaned = session.sanitizer.process(rawChunk);
            if (cleaned.promptMarkers > 0) {
                session.promptMarkerCount += cleaned.promptMarkers;
            }
            if (!cleaned.text)
                return;
            const redacted = redactTextSecrets(cleaned.text);
            session.scrollback = trimScrollback(session.scrollback + redacted);
            session.lastActivityAt = Date.now();
            this.broadcast(session, {
                type: 'output',
                sessionId: session.id,
                data: redacted,
                ts: session.lastActivityAt
            });
        };
        if (usePty) {
            proc.stdout.on('data', (buf) => {
                session.stdoutLineBuf += buf.toString('utf8');
                let nl = session.stdoutLineBuf.indexOf('\n');
                while (nl !== -1) {
                    const line = session.stdoutLineBuf.slice(0, nl).trim();
                    session.stdoutLineBuf = session.stdoutLineBuf.slice(nl + 1);
                    if (line) {
                        try {
                            const msg = JSON.parse(line);
                            if (msg.t === 'ready' && typeof msg.pid === 'number') {
                                session.childPid = msg.pid;
                            }
                            else if (msg.t === 'out' && typeof msg.b === 'string') {
                                const decoded = Buffer.from(msg.b, 'base64').toString('utf8');
                                appendOutput(decoded);
                            }
                            else if (msg.t === 'exit') {
                                session.exitCode = typeof msg.code === 'number' ? msg.code : 0;
                            }
                        }
                        catch {
                            // Ignore malformed framed line
                        }
                    }
                    nl = session.stdoutLineBuf.indexOf('\n');
                }
            });
            proc.stderr.on('data', (buf) => {
                const text = buf.toString('utf8');
                if (text.trim())
                    appendOutput(text);
            });
        }
        else {
            proc.stdout.on('data', (buf) => appendOutput(buf.toString('utf8')));
            proc.stderr.on('data', (buf) => appendOutput(buf.toString('utf8')));
        }
        proc.on('exit', (code) => {
            session.status = 'exited';
            if (session.exitCode === null) {
                session.exitCode = typeof code === 'number' ? code : 0;
            }
            session.lastActivityAt = Date.now();
            this.broadcast(session, {
                type: 'exit',
                sessionId: session.id,
                status: 'exited',
                exitCode: session.exitCode,
                ts: session.lastActivityAt
            });
        });
        proc.on('error', (err) => {
            appendOutput(`\n[terminal error: ${getErrorMessage(err)}]\n`);
            session.status = 'exited';
            session.exitCode = 1;
            this.broadcast(session, {
                type: 'exit',
                sessionId: session.id,
                status: 'exited',
                exitCode: 1,
                ts: Date.now()
            });
        });
        this.sessions.set(id, session);
        return this.toSummary(session);
    }
    writeInput(id, data, options = {}) {
        const session = this.sessions.get(id);
        if (!session)
            return { ok: false, control: 'user', error: `Terminal session "${id}" not found.`, code: 'NOT_FOUND' };
        if (session.status !== 'running') {
            return { ok: false, control: session.control, error: 'Terminal session has already exited.', code: 'SESSION_EXITED' };
        }
        if (data.includes('\0')) {
            return { ok: false, control: session.control, error: 'Input cannot contain NUL bytes.', code: 'INVALID_INPUT' };
        }
        const actor = options.actor ?? 'user';
        if (actor === 'user' && options.typed !== false && session.control === 'agent') {
            session.control = 'user';
            this.broadcast(session, {
                type: 'control',
                sessionId: session.id,
                control: 'user',
                ts: Date.now()
            });
        }
        else if (actor === 'agent' && session.control === 'user' && session.origin === 'agent') {
            return {
                ok: false,
                control: 'user',
                error: 'Terminal session was taken over by the user. Read-only inspection remains available.',
                code: 'TAKEN_OVER'
            };
        }
        try {
            if (session.transport === 'pty') {
                const frame = JSON.stringify({ t: 'in', b: Buffer.from(data, 'utf8').toString('base64') }) + '\n';
                session.proc.stdin.write(frame);
            }
            else {
                session.proc.stdin.write(data);
            }
            session.lastActivityAt = Date.now();
            return { ok: true, control: session.control };
        }
        catch (err) {
            return { ok: false, control: session.control, error: getErrorMessage(err), code: 'WRITE_FAILED' };
        }
    }
    resizeSession(id, cols, rows) {
        const session = this.sessions.get(id);
        if (!session || session.status !== 'running')
            return false;
        const safeCols = boundedInteger(cols, session.cols, 20, 400);
        const safeRows = boundedInteger(rows, session.rows, 6, 160);
        session.cols = safeCols;
        session.rows = safeRows;
        if (session.transport === 'pty') {
            try {
                session.proc.stdin.write(`${JSON.stringify({ t: 'resize', cols: safeCols, rows: safeRows })}\n`);
            }
            catch {
                return false;
            }
        }
        this.broadcast(session, {
            type: 'meta',
            sessionId: session.id,
            cols: safeCols,
            rows: safeRows,
            control: session.control,
            status: session.status,
            ts: Date.now()
        });
        return true;
    }
    signalSession(id, signalName, actor = 'user') {
        const session = this.sessions.get(id);
        if (!session)
            return { ok: false, error: `Terminal session "${id}" not found.`, code: 'NOT_FOUND' };
        if (session.status !== 'running')
            return { ok: false, error: 'Terminal session has already exited.', code: 'SESSION_EXITED' };
        if (!ALLOWED_SIGNALS.has(signalName))
            return { ok: false, error: `Unsupported signal: ${signalName}`, code: 'INVALID_SIGNAL' };
        if (signalName === 'SIGKILL') {
            return { ok: false, error: 'Refusing SIGKILL on interactive terminal session. Use SIGINT, SIGTERM, or close().', code: 'SIGNAL_DENIED' };
        }
        if (actor === 'agent' && session.control === 'user' && session.origin === 'agent') {
            return { ok: false, error: 'Terminal session was taken over by the user.', code: 'TAKEN_OVER' };
        }
        if (session.transport === 'pty') {
            try {
                session.proc.stdin.write(`${JSON.stringify({ t: 'sig', s: signalName })}\n`);
                return { ok: true };
            }
            catch (err) {
                return { ok: false, error: getErrorMessage(err) };
            }
        }
        if (signalName === 'SIGINT') {
            try {
                session.proc.stdin.write('\x03');
            }
            catch { /* ignore */ }
        }
        try {
            session.proc.kill(signalName);
            return { ok: true };
        }
        catch (err) {
            return { ok: false, error: getErrorMessage(err) };
        }
    }
    readScrollback(id, options = {}) {
        const session = this.sessions.get(id);
        if (!session) {
            return { ok: false, text: '', totalChars: 0, status: 'exited', exitCode: null, control: 'user' };
        }
        const total = session.scrollback.length;
        const limit = boundedInteger(options.tailChars, 16_000, 200, 64_000);
        const offset = boundedInteger(options.offsetFromEnd, 0, 0, total);
        const end = Math.max(0, total - offset);
        const start = Math.max(0, end - limit);
        return {
            ok: true,
            text: session.scrollback.slice(start, end),
            totalChars: total,
            status: session.status,
            exitCode: session.exitCode,
            control: session.control
        };
    }
    async sendAndWait(id, input, options = {}) {
        const session = this.sessions.get(id);
        if (!session) {
            return {
                ok: false,
                output: '',
                waitReason: 'session_exit',
                status: 'exited',
                exitCode: null,
                error: `Terminal session "${id}" not found.`,
                code: 'NOT_FOUND'
            };
        }
        const startLen = session.scrollback.length;
        const startMarkers = session.promptMarkerCount;
        const payload = options.submit === false ? input : `${input}\n`;
        const writeRes = this.writeInput(id, payload, { actor: options.actor ?? 'agent', typed: false });
        if (!writeRes.ok) {
            return {
                ok: false,
                output: '',
                waitReason: session.status === 'exited' ? 'session_exit' : 'timeout',
                status: session.status,
                exitCode: session.exitCode,
                error: writeRes.error,
                code: writeRes.code
            };
        }
        const timeoutMs = boundedInteger(options.timeoutMs, 15_000, 500, 90_000);
        const idleMs = boundedInteger(options.idleMs, 750, 200, 10_000);
        const deadline = Date.now() + timeoutMs;
        let lastDataAt = Date.now();
        let seenBytes = 0;
        return new Promise((resolve) => {
            let settled = false;
            let idleTimer = null;
            let hardTimer = null;
            const finish = (reason) => {
                if (settled)
                    return;
                settled = true;
                if (idleTimer)
                    clearTimeout(idleTimer);
                if (hardTimer)
                    clearTimeout(hardTimer);
                unsub();
                const delta = session.scrollback.length >= startLen
                    ? session.scrollback.slice(startLen)
                    : session.scrollback.slice(-Math.min(session.scrollback.length, 16_000));
                resolve({
                    ok: true,
                    output: delta.slice(0, 32_000),
                    waitReason: reason,
                    status: session.status,
                    exitCode: session.exitCode
                });
            };
            const scheduleIdle = () => {
                if (idleTimer)
                    clearTimeout(idleTimer);
                const remaining = Math.max(50, deadline - Date.now());
                idleTimer = setTimeout(() => {
                    if (session.promptMarkerCount > startMarkers) {
                        finish('stdin_read');
                    }
                    else if (seenBytes > 0 && Date.now() - lastDataAt >= idleMs - 40) {
                        finish('inferred_idle');
                    }
                    else if (Date.now() >= deadline) {
                        finish('timeout');
                    }
                    else {
                        scheduleIdle();
                    }
                }, Math.min(idleMs, remaining));
            };
            const unsub = this.subscribe(id, (ev) => {
                if (ev.type === 'exit') {
                    finish('session_exit');
                    return;
                }
                if (ev.type === 'output' && ev.data) {
                    seenBytes += ev.data.length;
                    lastDataAt = Date.now();
                    if (session.promptMarkerCount > startMarkers) {
                        // Brief settle to capture any trailing prompt text
                        setTimeout(() => finish('stdin_read'), 60);
                        return;
                    }
                    scheduleIdle();
                }
            }, false);
            hardTimer = setTimeout(() => finish('timeout'), timeoutMs);
            scheduleIdle();
        });
    }
    subscribe(id, listener, sendSnapshot = true) {
        const session = this.sessions.get(id);
        if (!session)
            return () => { };
        session.subscribers.add(listener);
        if (sendSnapshot) {
            try {
                listener({
                    type: 'snapshot',
                    sessionId: session.id,
                    data: session.scrollback,
                    control: session.control,
                    status: session.status,
                    exitCode: session.exitCode,
                    cols: session.cols,
                    rows: session.rows,
                    ts: Date.now()
                });
            }
            catch {
                // Ignore subscriber failure
            }
        }
        return () => {
            session.subscribers.delete(listener);
        };
    }
    closeSession(id) {
        const session = this.sessions.get(id);
        if (!session)
            return false;
        if (session.status === 'running') {
            if (session.transport === 'pty') {
                try {
                    session.proc.stdin.write(`${JSON.stringify({ t: 'close' })}\n`);
                }
                catch { /* ignore */ }
            }
            terminateChildTree(session.proc, session.detachedGroup, false);
            setTimeout(() => {
                if (session.status === 'running') {
                    terminateChildTree(session.proc, session.detachedGroup, true);
                }
            }, 600).unref?.();
        }
        session.status = 'exited';
        session.subscribers.clear();
        this.sessions.delete(id);
        return true;
    }
    closeAll() {
        for (const session of this.sessions.values()) {
            terminateChildTree(session.proc, session.detachedGroup, true);
            session.subscribers.clear();
        }
        this.sessions.clear();
    }
    broadcast(session, ev) {
        for (const sub of [...session.subscribers]) {
            try {
                sub(ev);
            }
            catch {
                // Isolate subscriber errors
            }
        }
    }
    toSummary(session) {
        return {
            id: session.id,
            name: session.name,
            shell: session.shell,
            shellLabel: session.shellLabel,
            cwd: session.cwd,
            workspaceRoot: session.workspaceRoot,
            origin: session.origin,
            control: session.control,
            transport: session.transport,
            status: session.status,
            exitCode: session.exitCode,
            cols: session.cols,
            rows: session.rows,
            createdAt: session.createdAt,
            lastActivityAt: session.lastActivityAt,
            scrollbackBytes: Buffer.byteLength(session.scrollback, 'utf8')
        };
    }
}
export const ptyTerminalManager = new PtyTerminalManager();
process.on('exit', () => {
    ptyTerminalManager.closeAll();
});
export const ptyTerminalTool = {
    schema: {
        name: 'terminal.pty',
        description: 'Manage real interactive PTY terminal sessions inside the workspace (REPLs, interactive CLIs, shells, debuggers). Supports open, send (with submit=false for raw control/partial input), read paginated scrollback, signal (SIGINT/SIGTERM/SIGTSTP/SIGHUP), resize, list, and close.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['open', 'send', 'read', 'signal', 'resize', 'list', 'close'],
                    description: 'Interactive PTY terminal action.'
                },
                sessionId: { type: 'string', description: 'Target terminal session ID (required for send, read, signal, resize, close).' },
                input: { type: 'string', description: 'Text or control sequence to send (for send action).' },
                submit: { type: 'boolean', description: 'Append newline after input (default true). Set false for raw/control input.' },
                shell: { type: 'string', description: 'Optional shell name (zsh, bash, sh) when opening a session.' },
                cwd: { type: 'string', description: 'Optional workspace-relative working directory when opening a session.' },
                name: { type: 'string', description: 'Optional display name for the terminal session.' },
                signal: {
                    type: 'string',
                    enum: ['SIGINT', 'SIGTERM', 'SIGTSTP', 'SIGHUP'],
                    description: 'POSIX signal for the signal action.'
                },
                cols: { type: 'integer', description: 'Terminal width in columns (20-400).' },
                rows: { type: 'integer', description: 'Terminal height in rows (6-160).' },
                timeoutMs: { type: 'integer', description: 'Maximum wait time in ms for send output (500-90000).' },
                tailChars: { type: 'integer', description: 'Maximum characters to return for read action (200-64000).' },
                offsetFromEnd: { type: 'integer', description: 'Offset backwards from newest scrollback end for pagination.' }
            },
            required: ['action'],
            additionalProperties: false
        }
    },
    async execute(args, context = {}) {
        try {
            const scope = resolveToolWorkspaceRoots(context);
            const workspaceRoot = scope.primaryRoot || process.cwd();
            const action = args?.action;
            if (action === 'list') {
                const sessions = ptyTerminalManager.listSessions(workspaceRoot);
                return {
                    success: true,
                    sessions,
                    shells: listAvailableShells(),
                    output: sessions.length === 0
                        ? 'No active interactive PTY sessions.'
                        : sessions.map((s) => `${s.id} (${s.shellLabel}, ${s.status}, control=${s.control}) — ${s.name}`).join('\n')
                };
            }
            if (action === 'open') {
                const created = ptyTerminalManager.openSession({
                    workspaceRoot,
                    cwd: args.cwd,
                    shell: args.shell,
                    name: args.name,
                    origin: 'agent',
                    cols: args.cols,
                    rows: args.rows
                });
                // Give shell brief startup settle so initial prompt is captured
                await new Promise((r) => setTimeout(r, 250));
                const initial = ptyTerminalManager.readScrollback(created.id, { tailChars: 4000 });
                return {
                    success: true,
                    session: created,
                    output: `Opened PTY session ${created.id} (${created.shellLabel}, ${created.transport}) in ${created.cwd}.\n${initial.text}`.trim()
                };
            }
            const sessionId = typeof args?.sessionId === 'string' ? args.sessionId.trim() : '';
            if (!sessionId)
                return { success: false, error: 'sessionId is required for this terminal action.' };
            if (action === 'send') {
                if (typeof args.input !== 'string')
                    return { success: false, error: 'input string is required for send action.' };
                const res = await ptyTerminalManager.sendAndWait(sessionId, args.input, {
                    submit: args.submit !== false,
                    timeoutMs: args.timeoutMs,
                    actor: 'agent'
                });
                if (!res.ok)
                    return { success: false, error: res.error || 'Terminal send failed.', code: res.code };
                return {
                    success: true,
                    waitReason: res.waitReason,
                    status: res.status,
                    exitCode: res.exitCode,
                    output: res.output || `(no new output; waitReason=${res.waitReason})`
                };
            }
            if (action === 'read') {
                const res = ptyTerminalManager.readScrollback(sessionId, {
                    tailChars: args.tailChars,
                    offsetFromEnd: args.offsetFromEnd
                });
                if (!res.ok)
                    return { success: false, error: `Terminal session "${sessionId}" not found.` };
                return {
                    success: true,
                    status: res.status,
                    exitCode: res.exitCode,
                    control: res.control,
                    totalChars: res.totalChars,
                    output: res.text || '(empty scrollback)'
                };
            }
            if (action === 'signal') {
                const sig = args.signal ?? 'SIGINT';
                const res = ptyTerminalManager.signalSession(sessionId, sig, 'agent');
                if (!res.ok)
                    return { success: false, error: res.error || 'Failed to deliver signal.', code: res.code };
                return { success: true, output: `Sent ${sig} to terminal session ${sessionId}.` };
            }
            if (action === 'resize') {
                const ok = ptyTerminalManager.resizeSession(sessionId, args.cols ?? 100, args.rows ?? 28);
                return ok
                    ? { success: true, output: `Resized terminal session ${sessionId}.` }
                    : { success: false, error: `Unable to resize terminal session "${sessionId}".` };
            }
            if (action === 'close') {
                const closed = ptyTerminalManager.closeSession(sessionId);
                return closed
                    ? { success: true, output: `Closed terminal session ${sessionId}.` }
                    : { success: false, error: `Terminal session "${sessionId}" not found.` };
            }
            return { success: false, error: `Unknown terminal.pty action: ${String(action)}` };
        }
        catch (error) {
            return { success: false, error: sanitizeToolError(error) };
        }
    }
};
