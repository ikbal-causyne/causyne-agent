import { announceAlert, dom } from './dom.js';
import { apiUrl, authHeaders, state } from './state.js';
import { hydrateStartShellOptions } from './studioStart.js';
import { setStudioTabDynamicTitle } from './studioShell.js';
import { TerminalTheme, observeTerminalCursor } from './terminalTheme.js';
const TYPED_INPUT_WINDOW_MS = 250;
const INPUT_GESTURES = ['keydown', 'beforeinput', 'paste', 'compositionend', 'drop', 'mousedown', 'touchstart'];
const FOCUS_REPORTS = new Set(['\x1b[I', '\x1b[O']);
const TERMINAL_FONT_STACK = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';
const mountedTerminals = new Map();
let viewportResizeObserver = null;
let themeObserver = null;
let streamAbort = null;
let streamedSessionId = null;
function resolveXtermConstructors() {
    const g = window;
    const TerminalCtor = g.Terminal;
    const FitCtor = typeof g.FitAddon === 'function' ? g.FitAddon : g.FitAddon?.FitAddon;
    if (typeof TerminalCtor !== 'function' || typeof FitCtor !== 'function')
        return null;
    return { TerminalCtor, FitCtor };
}
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
function readViewportThemeColors() {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const fallbackBg = isLight ? '#f6f8f6' : '#0d100d';
    const fallbackFg = isLight ? '#182018' : '#e6ece4';
    if (!dom.termViewport)
        return { background: fallbackBg, foreground: fallbackFg, isLight };
    const style = window.getComputedStyle(dom.termViewport);
    return {
        background: style.backgroundColor || fallbackBg,
        foreground: style.color || fallbackFg,
        isLight
    };
}
function applyThemeToAllMounted() {
    const { background, foreground, isLight } = readViewportThemeColors();
    for (const inst of mountedTerminals.values()) {
        inst.palette.update(background, foreground, isLight);
    }
}
function estimateInitialDimensions() {
    const curMounted = state.activeTerminalId ? mountedTerminals.get(state.activeTerminalId) : undefined;
    if (curMounted) {
        const proposed = curMounted.fitAddon.proposeDimensions();
        if (proposed && Number.isFinite(proposed.cols) && Number.isFinite(proposed.rows)) {
            return {
                cols: Math.max(20, Math.min(400, proposed.cols)),
                rows: Math.max(6, Math.min(160, proposed.rows))
            };
        }
    }
    const rect = dom.termViewport?.getBoundingClientRect();
    if (rect && rect.width > 120 && rect.height > 80) {
        const cols = Math.max(20, Math.min(400, Math.floor((rect.width - 28) / 7.8)));
        const rows = Math.max(6, Math.min(160, Math.floor((rect.height - 16) / 18)));
        return { cols, rows };
    }
    return { cols: 88, rows: 26 };
}
function syncTerminalChrome() {
    const cur = activeSession();
    const hasSession = Boolean(cur);
    if (dom.termEmpty)
        dom.termEmpty.style.display = hasSession ? 'none' : 'flex';
    if (dom.termViewport)
        dom.termViewport.style.display = hasSession ? 'flex' : 'none';
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
    setStudioTabDynamicTitle('terminal', cur ? cur.name : null);
}
function syncVisibleTerminalInstance() {
    for (const [id, inst] of mountedTerminals) {
        const isActive = id === state.activeTerminalId;
        inst.hostEl.classList.toggle('active', isActive);
    }
}
function scheduleRemoteResize(inst, cols, rows) {
    if (inst.lastSyncedCols === cols && inst.lastSyncedRows === rows)
        return;
    const sess = state.terminalSessions.find((s) => s.id === inst.sessionId);
    if (!sess || sess.status !== 'running')
        return;
    if (inst.resizeTimer)
        clearTimeout(inst.resizeTimer);
    inst.resizeTimer = setTimeout(() => {
        inst.resizeTimer = null;
        if (inst.lastSyncedCols === cols && inst.lastSyncedRows === rows)
            return;
        inst.lastSyncedCols = cols;
        inst.lastSyncedRows = rows;
        sess.cols = cols;
        sess.rows = rows;
        if (state.activeTerminalId === inst.sessionId && dom.termMeta) {
            dom.termMeta.textContent = `${sess.shellLabel} · ${cols}×${rows}`;
        }
        void fetch(apiUrl('/api/terminal/input'), {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ id: inst.sessionId, cols, rows })
        }).catch(() => null);
    }, 60);
}
function fitTerminalInstance(inst) {
    if (!dom.termViewport || !inst.hostEl.classList.contains('active'))
        return;
    if (inst.hostEl.clientWidth < 40 || inst.hostEl.clientHeight < 30)
        return;
    const dims = inst.fitAddon.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows))
        return;
    const cols = Math.max(20, Math.min(400, dims.cols));
    const rows = Math.max(6, Math.min(160, dims.rows));
    if (inst.xterm.cols !== cols || inst.xterm.rows !== rows) {
        inst.xterm.resize(cols, rows);
    }
    scheduleRemoteResize(inst, cols, rows);
}
export function fitActiveTerminal() {
    if (!state.activeTerminalId)
        return;
    const inst = mountedTerminals.get(state.activeTerminalId);
    if (!inst)
        return;
    requestAnimationFrame(() => {
        fitTerminalInstance(inst);
    });
}
export function focusActiveTerminal() {
    if (!state.activeTerminalId)
        return;
    const inst = mountedTerminals.get(state.activeTerminalId);
    if (inst)
        inst.xterm.focus();
}
function flushInputQueue(inst) {
    if (inst.flushingInput || inst.pendingInput.length === 0)
        return;
    inst.flushingInput = true;
    void (async () => {
        try {
            while (inst.pendingInput.length > 0) {
                const first = inst.pendingInput.shift();
                let combined = first.data;
                let typed = first.typed;
                while (inst.pendingInput.length > 0 && inst.pendingInput[0].typed === typed) {
                    combined += inst.pendingInput.shift().data;
                }
                const res = await fetch(apiUrl('/api/terminal/input'), {
                    method: 'POST',
                    headers: authHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({ id: inst.sessionId, data: combined, typed })
                }).catch(() => null);
                if (res && res.ok) {
                    const body = await res.json().catch(() => ({}));
                    const target = state.terminalSessions.find((s) => s.id === inst.sessionId);
                    if (target && body.control && target.control !== body.control) {
                        target.control = body.control;
                        syncTerminalChrome();
                    }
                }
            }
        }
        finally {
            inst.flushingInput = false;
        }
    })();
}
function enqueueTerminalInput(sessionId, data, typed) {
    const inst = mountedTerminals.get(sessionId);
    if (!inst)
        return;
    inst.pendingInput.push({ data, typed });
    flushInputQueue(inst);
}
function disposeMountedTerminal(sessionId) {
    const inst = mountedTerminals.get(sessionId);
    if (!inst)
        return;
    if (inst.resizeTimer)
        clearTimeout(inst.resizeTimer);
    inst.cleanupGestures();
    inst.dataSub.dispose();
    inst.cursorSub.dispose();
    inst.palette.dispose();
    inst.xterm.dispose();
    inst.hostEl.remove();
    mountedTerminals.delete(sessionId);
}
function ensureMountedTerminal(session) {
    const existing = mountedTerminals.get(session.id);
    if (existing)
        return existing;
    if (!dom.termViewport)
        return null;
    const ctors = resolveXtermConstructors();
    if (!ctors) {
        announceAlert('Terminal emulator assets failed to load.');
        return null;
    }
    const hostEl = document.createElement('div');
    hostEl.className = 'term-instance';
    hostEl.dataset.sessionId = session.id;
    if (session.id === state.activeTerminalId)
        hostEl.classList.add('active');
    dom.termViewport.appendChild(hostEl);
    const xterm = new ctors.TerminalCtor({
        cols: Math.max(20, Math.min(400, session.cols || 88)),
        rows: Math.max(6, Math.min(160, session.rows || 26)),
        cursorBlink: true,
        cursorStyle: 'block',
        fontFamily: TERMINAL_FONT_STACK,
        fontSize: 13,
        lineHeight: 1.25,
        minimumContrastRatio: 4.5,
        scrollback: 5000,
        convertEol: session.transport !== 'pty',
        allowProposedApi: false
    });
    const fitAddon = new ctors.FitCtor();
    xterm.loadAddon(fitAddon);
    xterm.open(hostEl);
    xterm.textarea?.setAttribute('aria-label', `${session.name} interactive terminal`);
    const palette = new TerminalTheme(xterm);
    const { background, foreground, isLight } = readViewportThemeColors();
    palette.update(background, foreground, isLight);
    const cursorSub = observeTerminalCursor(xterm, hostEl, () => palette.cursor);
    // Copy on Ctrl+C / Cmd+C when text is selected instead of sending SIGINT; allow paste naturally
    xterm.attachCustomKeyEventHandler((ev) => {
        const key = ev.key.toLowerCase();
        if ((ev.metaKey || ev.ctrlKey) && key === 'c' && xterm.hasSelection()) {
            if (ev.type === 'keydown' && navigator.clipboard?.writeText) {
                void navigator.clipboard.writeText(xterm.getSelection()).catch(() => { });
            }
            return false;
        }
        if ((ev.metaKey || (ev.ctrlKey && ev.shiftKey)) && key === 'v') {
            return false;
        }
        if (ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key === '`') {
            return false;
        }
        return true;
    });
    let gestureAt = Number.NEGATIVE_INFINITY;
    const markGesture = () => { gestureAt = performance.now(); };
    for (const type of INPUT_GESTURES) {
        hostEl.addEventListener(type, markGesture, { capture: true, passive: true });
    }
    const cleanupGestures = () => {
        for (const type of INPUT_GESTURES) {
            hostEl.removeEventListener(type, markGesture, { capture: true });
        }
    };
    const dataSub = xterm.onData((data) => {
        const isTyped = (performance.now() - gestureAt < TYPED_INPUT_WINDOW_MS) && !FOCUS_REPORTS.has(data);
        enqueueTerminalInput(session.id, data, isTyped);
    });
    const inst = {
        sessionId: session.id,
        hostEl,
        xterm,
        fitAddon,
        palette,
        cursorSub,
        dataSub,
        cleanupGestures,
        lastSyncedCols: session.cols,
        lastSyncedRows: session.rows,
        resizeTimer: null,
        pendingInput: [],
        flushingInput: false
    };
    mountedTerminals.set(session.id, inst);
    return inst;
}
function renderTerminalTabs() {
    if (!dom.termTabs || !dom.termNewBtn)
        return;
    dom.termTabs.textContent = '';
    for (const sess of state.terminalSessions) {
        const pill = document.createElement('div');
        pill.className = `btab${sess.id === state.activeTerminalId ? ' active' : ''}`;
        pill.addEventListener('auxclick', (e) => {
            if (e.button === 1) {
                e.preventDefault();
                void closeTerminalSession(sess.id);
            }
        });
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
        cls.setAttribute('aria-label', `Close ${sess.name}`);
        cls.addEventListener('click', () => { void closeTerminalSession(sess.id); });
        pill.appendChild(lbl);
        pill.appendChild(cls);
        dom.termTabs.appendChild(pill);
    }
    dom.termTabs.appendChild(dom.termNewBtn);
    syncTerminalChrome();
    syncVisibleTerminalInstance();
}
function startTerminalStream(sessionId) {
    if (streamedSessionId === sessionId && streamAbort)
        return;
    stopTerminalStream();
    const sess = state.terminalSessions.find((s) => s.id === sessionId);
    if (!sess)
        return;
    const inst = ensureMountedTerminal(sess);
    syncVisibleTerminalInstance();
    if (inst) {
        requestAnimationFrame(() => fitTerminalInstance(inst));
    }
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
                            const mounted = mountedTerminals.get(sessionId);
                            if (ev.type === 'snapshot') {
                                if (target) {
                                    if (ev.control)
                                        target.control = ev.control;
                                    if (ev.status)
                                        target.status = ev.status;
                                    if (ev.exitCode !== undefined)
                                        target.exitCode = ev.exitCode;
                                    if (typeof ev.cols === 'number')
                                        target.cols = ev.cols;
                                    if (typeof ev.rows === 'number')
                                        target.rows = ev.rows;
                                }
                                if (mounted) {
                                    mounted.xterm.reset();
                                    const payload = typeof ev.rawData === 'string' ? ev.rawData : (ev.data || '');
                                    if (payload)
                                        mounted.xterm.write(payload);
                                    requestAnimationFrame(() => fitTerminalInstance(mounted));
                                }
                                syncTerminalChrome();
                            }
                            else if (ev.type === 'output') {
                                const payload = typeof ev.rawData === 'string' ? ev.rawData : (ev.data || '');
                                if (mounted && payload) {
                                    mounted.xterm.write(payload);
                                }
                            }
                            else if (ev.type === 'meta') {
                                if (target) {
                                    if (typeof ev.cols === 'number')
                                        target.cols = ev.cols;
                                    if (typeof ev.rows === 'number')
                                        target.rows = ev.rows;
                                    if (ev.control)
                                        target.control = ev.control;
                                    if (ev.status)
                                        target.status = ev.status;
                                }
                                syncTerminalChrome();
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
                                if (mounted) {
                                    mounted.xterm.write(`\r\n\x1b[2m[process exited with code ${ev.exitCode ?? 0}]\x1b[0m\r\n`);
                                }
                                renderTerminalTabs();
                            }
                        }
                        catch {
                            // Ignore malformed stream line
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
    const sess = activeSession();
    if (sess)
        ensureMountedTerminal(sess);
    renderTerminalTabs();
    startTerminalStream(sessionId);
    fitActiveTerminal();
    focusActiveTerminal();
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
    const incoming = Array.isArray(data.sessions) ? data.sessions : [];
    const validIds = new Set(incoming.map((s) => s.id));
    for (const id of [...mountedTerminals.keys()]) {
        if (!validIds.has(id))
            disposeMountedTerminal(id);
    }
    state.terminalSessions = incoming;
    if (state.activeTerminalId && !validIds.has(state.activeTerminalId)) {
        state.activeTerminalId = null;
        stopTerminalStream();
    }
    if (!state.activeTerminalId && state.terminalSessions.length > 0) {
        state.activeTerminalId = state.terminalSessions[0].id;
    }
    const cur = activeSession();
    if (cur)
        ensureMountedTerminal(cur);
    renderTerminalTabs();
    if (state.activeTerminalId) {
        startTerminalStream(state.activeTerminalId);
        fitActiveTerminal();
    }
}
export async function openNewTerminalSession(shell) {
    const chosenShell = shell || dom.termShellSelect?.value || dom.startShellSelect?.value || undefined;
    const { cols, rows } = estimateInitialDimensions();
    const res = await fetch(apiUrl('/api/terminal/sessions'), {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ shell: chosenShell, cols, rows })
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
}
export async function closeTerminalSession(sessionId) {
    await fetch(apiUrl(`/api/terminal/sessions/${encodeURIComponent(sessionId)}`), {
        method: 'DELETE',
        headers: authHeaders()
    }).catch(() => null);
    disposeMountedTerminal(sessionId);
    state.terminalSessions = state.terminalSessions.filter((s) => s.id !== sessionId);
    if (state.activeTerminalId === sessionId) {
        stopTerminalStream();
        state.activeTerminalId = state.terminalSessions[0]?.id ?? null;
    }
    renderTerminalTabs();
    if (state.activeTerminalId) {
        startTerminalStream(state.activeTerminalId);
        fitActiveTerminal();
    }
}
export async function closeAllTerminalSessions() {
    const ids = state.terminalSessions.map((s) => s.id);
    stopTerminalStream();
    for (const id of ids) {
        disposeMountedTerminal(id);
        await fetch(apiUrl(`/api/terminal/sessions/${encodeURIComponent(id)}`), {
            method: 'DELETE',
            headers: authHeaders()
        }).catch(() => null);
    }
    state.terminalSessions = [];
    state.activeTerminalId = null;
    renderTerminalTabs();
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
    dom.termSigintBtn?.addEventListener('click', () => {
        void sendTerminalSignal('SIGINT');
        focusActiveTerminal();
    });
    dom.termClearBtn?.addEventListener('click', () => {
        if (!state.activeTerminalId)
            return;
        const inst = mountedTerminals.get(state.activeTerminalId);
        if (inst) {
            inst.xterm.clear();
            inst.xterm.focus();
        }
    });
    dom.termTakeControlBtn?.addEventListener('click', () => {
        if (!state.activeTerminalId)
            return;
        enqueueTerminalInput(state.activeTerminalId, '', true);
        focusActiveTerminal();
    });
    if (dom.termViewport && typeof ResizeObserver !== 'undefined') {
        viewportResizeObserver = new ResizeObserver(() => {
            if (!state.activeTerminalId)
                return;
            const inst = mountedTerminals.get(state.activeTerminalId);
            if (inst)
                fitTerminalInstance(inst);
        });
        viewportResizeObserver.observe(dom.termViewport);
    }
    if (typeof MutationObserver !== 'undefined') {
        themeObserver = new MutationObserver(() => {
            applyThemeToAllMounted();
        });
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
    window.addEventListener('beforeunload', () => {
        stopTerminalStream();
        viewportResizeObserver?.disconnect();
        themeObserver?.disconnect();
    });
}
