import { announceAlert, dom } from './dom.js';
import { apiUrl, authHeaders, state } from './state.js';
import { hydrateStartShellOptions } from './studioStart.js';
const MAX_CLIENT_VIEWPORT_CHARS = 180_000;
const cmdHistory = [];
let historyIdx = -1;
let streamAbort = null;
let streamedSessionId = null;
function stopTerminalStream() {
    if (streamAbort) {
        try {
            streamAbort.abort();
        }
        catch { /* ignore */ }
        streamAbort = null;
    }
    streamedSessionId = null;
}
function activeSession() {
    if (!state.activeTerminalId)
        return null;
    return state.terminalSessions.find((s) => s.id === state.activeTerminalId) ?? null;
}
function syncTerminalChrome() {
    const cur = activeSession();
    const hasSession = Boolean(cur);
    if (dom.termEmpty)
        dom.termEmpty.style.display = hasSession ? 'none' : 'flex';
    if (dom.termViewport)
        dom.termViewport.style.display = hasSession ? 'block' : 'none';
    if (dom.termControlBanner) {
        const showAgentBanner = Boolean(cur && cur.status === 'running' && cur.control === 'agent');
        dom.termControlBanner.classList.toggle('visible', showAgentBanner);
        if (dom.termControlText && showAgentBanner) {
            dom.termControlText.textContent = `Causyne is driving ${cur?.name || 'terminal'}`;
        }
    }
    if (dom.termStatus) {
        if (!cur) {
            dom.termStatus.textContent = 'No active terminal';
        }
        else if (cur.status === 'exited') {
            dom.termStatus.textContent = `${cur.name} · exited (${cur.exitCode ?? 0})`;
        }
        else {
            dom.termStatus.textContent = `${cur.name} · ${cur.transport.toUpperCase()} · ${cur.control === 'agent' ? 'agent control' : 'interactive'}`;
        }
    }
    if (dom.termMeta) {
        dom.termMeta.textContent = cur ? `${cur.shellLabel} · ${cur.cols}×${cur.rows}` : '';
    }
}
function renderTerminalTabs() {
    if (!dom.termTabs || !dom.termNewBtn)
        return;
    dom.termTabs.textContent = '';
    for (const sess of state.terminalSessions) {
        const pill = document.createElement('div');
        pill.className = `btab${sess.id === state.activeTerminalId ? ' active' : ''}`;
        const lbl = document.createElement('button');
        lbl.type = 'button';
        lbl.className = 'btab-label';
        lbl.textContent = sess.status === 'exited' ? `${sess.name} (exited)` : sess.name;
        lbl.addEventListener('click', () => { selectTerminalSession(sess.id); });
        const cls = document.createElement('button');
        cls.type = 'button';
        cls.className = 'btab-close';
        cls.textContent = '×';
        cls.title = 'Close terminal';
        cls.addEventListener('click', () => { void closeTerminalSession(sess.id); });
        pill.appendChild(lbl);
        pill.appendChild(cls);
        dom.termTabs.appendChild(pill);
    }
    dom.termTabs.appendChild(dom.termNewBtn);
    syncTerminalChrome();
}
function appendViewportText(chunk, replace = false) {
    if (!dom.termViewport)
        return;
    const next = replace ? chunk : ((dom.termViewport.textContent || '') + chunk);
    dom.termViewport.textContent = next.length > MAX_CLIENT_VIEWPORT_CHARS
        ? next.slice(next.length - MAX_CLIENT_VIEWPORT_CHARS)
        : next;
    dom.termViewport.scrollTop = dom.termViewport.scrollHeight;
}
function startTerminalStream(sessionId) {
    if (streamedSessionId === sessionId && streamAbort)
        return;
    stopTerminalStream();
    const ctrl = new AbortController();
    streamAbort = ctrl;
    streamedSessionId = sessionId;
    void (async () => {
        try {
            const res = await fetch(apiUrl(`/api/terminal/stream?id=${encodeURIComponent(sessionId)}`), { headers: authHeaders(), signal: ctrl.signal });
            if (!res.ok || !res.body)
                return;
            const reader = res.body.getReader();
            const dec = new TextDecoder();
            let buf = '';
            while (true) {
                const step = await reader.read();
                if (step.done)
                    break;
                buf += dec.decode(step.value, { stream: true });
                let nl = buf.indexOf('\n');
                while (nl !== -1) {
                    const line = buf.slice(0, nl).trim();
                    buf = buf.slice(nl + 1);
                    if (line) {
                        try {
                            const ev = JSON.parse(line);
                            const target = state.terminalSessions.find((s) => s.id === sessionId);
                            if (ev.type === 'snapshot') {
                                if (sessionId === state.activeTerminalId) {
                                    appendViewportText(ev.data || '', true);
                                }
                                if (target) {
                                    if (ev.control)
                                        target.control = ev.control;
                                    if (ev.status)
                                        target.status = ev.status;
                                    if (ev.exitCode !== undefined)
                                        target.exitCode = ev.exitCode;
                                }
                                syncTerminalChrome();
                            }
                            else if (ev.type === 'output' && typeof ev.data === 'string') {
                                if (sessionId === state.activeTerminalId) {
                                    appendViewportText(ev.data, false);
                                }
                            }
                            else if (ev.type === 'control' && ev.control) {
                                if (target)
                                    target.control = ev.control;
                                syncTerminalChrome();
                            }
                            else if (ev.type === 'exit') {
                                if (target) {
                                    target.status = 'exited';
                                    target.exitCode = ev.exitCode ?? 0;
                                }
                                if (sessionId === state.activeTerminalId) {
                                    appendViewportText(`\n[process exited with code ${ev.exitCode ?? 0}]\n`, false);
                                }
                                renderTerminalTabs();
                            }
                        }
                        catch {
                            // Ignore malformed line
                        }
                    }
                    nl = buf.indexOf('\n');
                }
            }
        }
        catch {
            // Aborted cleanly
        }
        finally {
            if (streamAbort === ctrl) {
                streamAbort = null;
                streamedSessionId = null;
            }
        }
    })();
}
export function selectTerminalSession(sessionId) {
    state.activeTerminalId = sessionId;
    renderTerminalTabs();
    startTerminalStream(sessionId);
}
export async function loadTerminalSessions() {
    const res = await fetch(apiUrl('/api/terminal/sessions'), { headers: authHeaders() }).catch(() => null);
    if (!res || !res.ok)
        return;
    const data = await res.json();
    if (Array.isArray(data.shells)) {
        state.availableShells = data.shells;
        hydrateStartShellOptions(data.shells);
    }
    state.terminalSessions = Array.isArray(data.sessions) ? data.sessions : [];
    if (state.activeTerminalId && !state.terminalSessions.some((s) => s.id === state.activeTerminalId)) {
        state.activeTerminalId = null;
        stopTerminalStream();
    }
    if (!state.activeTerminalId && state.terminalSessions.length > 0) {
        state.activeTerminalId = state.terminalSessions[0].id;
    }
    renderTerminalTabs();
    if (state.activeTerminalId) {
        startTerminalStream(state.activeTerminalId);
    }
}
export async function openNewTerminalSession(shell) {
    const chosenShell = shell || dom.termShellSelect?.value || dom.startShellSelect?.value || undefined;
    const res = await fetch(apiUrl('/api/terminal/sessions'), {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ shell: chosenShell, cols: 100, rows: 28 })
    }).catch(() => null);
    if (!res) {
        announceAlert('Failed to open workspace terminal.');
        return;
    }
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok || !data.session) {
        announceAlert(data.error || 'Failed to open workspace terminal.');
        return;
    }
    state.terminalSessions.push(data.session);
    selectTerminalSession(data.session.id);
    dom.termInput?.focus();
}
export async function closeTerminalSession(sessionId) {
    await fetch(apiUrl(`/api/terminal/sessions/${encodeURIComponent(sessionId)}`), {
        method: 'DELETE',
        headers: authHeaders()
    }).catch(() => null);
    state.terminalSessions = state.terminalSessions.filter((s) => s.id !== sessionId);
    if (state.activeTerminalId === sessionId) {
        stopTerminalStream();
        state.activeTerminalId = state.terminalSessions[0]?.id ?? null;
        if (dom.termViewport && !state.activeTerminalId)
            dom.termViewport.textContent = '';
    }
    renderTerminalTabs();
    if (state.activeTerminalId)
        startTerminalStream(state.activeTerminalId);
}
async function sendTerminalData(data, typed = true) {
    if (!state.activeTerminalId) {
        await openNewTerminalSession();
    }
    const id = state.activeTerminalId;
    if (!id)
        return;
    const res = await fetch(apiUrl('/api/terminal/input'), {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ id, data, typed })
    }).catch(() => null);
    if (res && res.ok) {
        const body = await res.json().catch(() => ({}));
        const cur = activeSession();
        if (cur && body.control) {
            cur.control = body.control;
            syncTerminalChrome();
        }
    }
}
async function sendTerminalSignal(signal) {
    const id = state.activeTerminalId;
    if (!id)
        return;
    await fetch(apiUrl('/api/terminal/signal'), {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ id, signal })
    }).catch(() => null);
}
export function deactivateTerminalPanel() {
    stopTerminalStream();
}
export function bindTerminalPanelEvents() {
    dom.termNewBtn?.addEventListener('click', () => { void openNewTerminalSession(); });
    dom.termEmptyStartBtn?.addEventListener('click', () => { void openNewTerminalSession(); });
    dom.termSigintBtn?.addEventListener('click', () => { void sendTerminalSignal('SIGINT'); });
    dom.termClearBtn?.addEventListener('click', () => {
        if (dom.termViewport)
            dom.termViewport.textContent = '';
    });
    dom.termTakeControlBtn?.addEventListener('click', () => {
        void sendTerminalData('', true);
        dom.termInput?.focus();
    });
    const submitCommandLine = () => {
        if (!dom.termInput)
            return;
        const line = dom.termInput.value;
        if (line.trim()) {
            cmdHistory.push(line);
            if (cmdHistory.length > 100)
                cmdHistory.shift();
            historyIdx = cmdHistory.length;
        }
        dom.termInput.value = '';
        void sendTerminalData(`${line}\n`, true);
    };
    dom.termSendBtn?.addEventListener('click', submitCommandLine);
    dom.termInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            submitCommandLine();
        }
        else if (e.ctrlKey && e.key.toLowerCase() === 'c') {
            e.preventDefault();
            void sendTerminalSignal('SIGINT');
        }
        else if (e.key === 'ArrowUp' && cmdHistory.length > 0) {
            e.preventDefault();
            historyIdx = Math.max(0, (historyIdx < 0 ? cmdHistory.length : historyIdx) - 1);
            if (dom.termInput)
                dom.termInput.value = cmdHistory[historyIdx] ?? '';
        }
        else if (e.key === 'ArrowDown' && cmdHistory.length > 0) {
            e.preventDefault();
            historyIdx = Math.min(cmdHistory.length, historyIdx + 1);
            if (dom.termInput)
                dom.termInput.value = cmdHistory[historyIdx] ?? '';
        }
    });
    // Direct interactive keyboard forwarding when viewport itself is focused
    dom.termViewport?.addEventListener('keydown', (e) => {
        if (!state.activeTerminalId)
            return;
        if (e.metaKey)
            return;
        if (e.ctrlKey && e.key.toLowerCase() === 'c') {
            e.preventDefault();
            void sendTerminalSignal('SIGINT');
            return;
        }
        if (e.ctrlKey && e.key.toLowerCase() === 'd') {
            e.preventDefault();
            void sendTerminalData('\x04', true);
            return;
        }
        if (e.ctrlKey && e.key.toLowerCase() === 'l') {
            e.preventDefault();
            if (dom.termViewport)
                dom.termViewport.textContent = '';
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            void sendTerminalData('\n', true);
            return;
        }
        if (e.key === 'Backspace') {
            e.preventDefault();
            void sendTerminalData('\x7f', true);
            return;
        }
        if (e.key === 'Tab') {
            e.preventDefault();
            void sendTerminalData('\t', true);
            return;
        }
        if (e.key.length === 1 && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            void sendTerminalData(e.key, true);
        }
    });
    window.addEventListener('beforeunload', stopTerminalStream);
}
