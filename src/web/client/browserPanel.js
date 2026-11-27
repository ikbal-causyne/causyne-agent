import { announceAlert, dom } from './dom.js';
import { apiUrl, authHeaders, state } from './state.js';
import { isHtmlOrSvgPath, parseLoopbackUrl } from './validators.js';
import { closeAllPopovers, openStudio, positionPopover } from './studioShell.js';
export function stopLiveBrowserStream() {
    if (state.liveStreamAbort) {
        try {
            state.liveStreamAbort.abort();
        }
        catch { /* ignore */ }
        state.liveStreamAbort = null;
    }
    state.liveStreamConnected = false;
}
export function updateAgentBrowserBanner(activity) {
    const active = Boolean(activity && activity.active);
    dom.browserAgentBanner.classList.toggle('visible', active && state.liveBrowserActive);
    dom.liveViewportSurface.classList.toggle('agent-active', active || state.controlOwner === 'agent');
    if (active) {
        dom.browserAgentBannerText.textContent = 'Causyne is browsing';
    }
}
export function applyLiveBrowserFrame(data) {
    if (!data)
        return;
    state.liveBrowserActive = Boolean(data.active);
    if (typeof data.visible === 'boolean')
        state.liveBrowserVisible = data.visible;
    if (data.engine !== undefined)
        state.liveBrowserRuntime = data.engine;
    if (typeof data.enginePreference === 'string') {
        state.liveBrowserPref = data.enginePreference;
        if (dom.browserEngineSelect && dom.browserEngineSelect.value !== data.enginePreference) {
            dom.browserEngineSelect.value = data.enginePreference;
        }
    }
    if (data.enginesAvailable && dom.browserEngineSelect) {
        const optCf = dom.browserEngineSelect.querySelector('option[value=camoufox]');
        const optCh = dom.browserEngineSelect.querySelector('option[value=chromium]');
        if (optCf)
            optCf.textContent = data.enginesAvailable.camoufox ? 'Camoufox' : 'Camoufox (unavailable)';
        if (optCh)
            optCh.textContent = data.enginesAvailable.chromium ? 'Chromium' : 'Chromium (unavailable)';
    }
    if (typeof data.streamMode === 'string')
        state.liveStreamMode = data.streamMode;
    if (typeof data.fps === 'number')
        state.liveFps = data.fps;
    state.controlOwner = data.controlOwner === 'agent' ? 'agent' : 'human';
    if (typeof data.width === 'number' && data.width > 0)
        state.liveBrowserWidth = data.width;
    if (typeof data.height === 'number' && data.height > 0)
        state.liveBrowserHeight = data.height;
    dom.browserHandoffBtn.textContent = state.controlOwner === 'agent' ? 'Take control' : 'Let Causyne browse';
    dom.browserNativeWinBtn.classList.toggle('active', state.liveBrowserVisible);
    dom.browserNativeWinBtn.title = state.liveBrowserVisible ? 'Return browser to panel' : 'Open in desktop window';
    if (data.agentActivity)
        updateAgentBrowserBanner(data.agentActivity);
    if (Array.isArray(data.tabs)) {
        dom.browserTabsEl.textContent = '';
        for (const tab of data.tabs) {
            const pill = document.createElement('div');
            pill.className = `btab${tab.active ? ' active' : ''}`;
            const lbl = document.createElement('button');
            lbl.type = 'button';
            lbl.className = 'btab-label';
            lbl.textContent = tab.title || tab.url || 'New tab';
            lbl.addEventListener('click', () => { void runBrowserAction({ action: 'switchTab', tabId: tab.tabId }); });
            const cls = document.createElement('button');
            cls.type = 'button';
            cls.className = 'btab-close';
            cls.textContent = '×';
            cls.addEventListener('click', () => { void runBrowserAction({ action: 'closeTab', tabId: tab.tabId }); });
            pill.appendChild(lbl);
            pill.appendChild(cls);
            dom.browserTabsEl.appendChild(pill);
        }
        dom.browserTabsEl.appendChild(dom.browserNewTabBtn);
    }
    if (state.browserEngine !== 'agent')
        return;
    if (data.url && document.activeElement !== dom.browserUrlInput)
        dom.browserUrlInput.value = data.url;
    if (data.active && data.imageBase64) {
        dom.browserEmpty.style.display = 'none';
        dom.browserFrame.style.display = 'none';
        dom.liveBrowserImg.src = `data:${data.mimeType || 'image/jpeg'};base64,${data.imageBase64}`;
        dom.liveBrowserImg.style.display = 'block';
    }
    else if (!data.active) {
        dom.liveBrowserImg.style.display = 'none';
        dom.browserAgentBanner.classList.remove('visible');
        dom.browserEmpty.style.display = 'flex';
    }
}
export function startLiveBrowserStream() {
    if (state.liveStreamAbort
        || !dom.appEl.classList.contains('studio-open')
        || state.studioTab !== 'browser'
        || state.browserEngine !== 'agent') {
        return;
    }
    const ctrl = new AbortController();
    state.liveStreamAbort = ctrl;
    void (async () => {
        try {
            const res = await fetch(apiUrl('/api/browser/stream'), {
                headers: authHeaders(),
                signal: ctrl.signal
            });
            if (!res.ok || !res.body)
                return;
            state.liveStreamConnected = true;
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
                            if (ev.type === 'agent_activity') {
                                if (ev.controlOwner) {
                                    state.controlOwner = ev.controlOwner === 'agent' ? 'agent' : 'human';
                                    dom.browserHandoffBtn.textContent = state.controlOwner === 'agent'
                                        ? 'Take control'
                                        : 'Let Causyne browse';
                                }
                                updateAgentBrowserBanner(ev.agentActivity);
                            }
                            else if (ev.type === 'frame' || ev.type === 'meta' || ev.type === 'closed') {
                                applyLiveBrowserFrame(ev);
                            }
                        }
                        catch { /* ignore malformed frame */ }
                    }
                    nl = buf.indexOf('\n');
                }
            }
        }
        catch {
            // Stream aborted cleanly or server closed.
        }
        finally {
            if (state.liveStreamAbort === ctrl) {
                state.liveStreamAbort = null;
                state.liveStreamConnected = false;
            }
        }
    })();
}
export async function refreshLiveBrowserState(ensureStarted) {
    const qs = ensureStarted ? '?ensure=1' : '';
    const res = await fetch(apiUrl(`/api/browser/state${qs}`), { headers: authHeaders() }).catch(() => null);
    if (!res || !res.ok)
        return;
    applyLiveBrowserFrame(await res.json());
}
export async function runBrowserAction(payload) {
    const res = await fetch(apiUrl('/api/browser/action'), {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload)
    }).catch(() => null);
    if (!res) {
        announceAlert('Browser action failed.');
        return null;
    }
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) {
        announceAlert(data.error || 'Browser action failed.');
        return null;
    }
    applyLiveBrowserFrame(data);
    return data;
}
export function setBrowserEngine(engine) {
    state.browserEngine = engine === 'frame' ? 'frame' : 'agent';
    dom.bmodeAgentBtn.classList.toggle('active', state.browserEngine === 'agent');
    dom.bmodeFrameBtn.classList.toggle('active', state.browserEngine === 'frame');
    const isAgent = state.browserEngine === 'agent';
    dom.browserNewTabBtn.style.display = isAgent ? 'inline-flex' : 'none';
    dom.browserNativeWinBtn.style.display = isAgent ? 'inline-flex' : 'none';
    dom.browserSyncToggleBtn.style.display = isAgent ? 'inline-flex' : 'none';
    if (!isAgent) {
        dom.browserSyncDrawer.classList.remove('open');
        dom.browserSyncToggleBtn.classList.remove('active');
    }
    if (isAgent) {
        dom.browserFrame.style.display = 'none';
        dom.liveViewportSurface.style.display = 'flex';
        void refreshLiveBrowserState(false);
        startLiveBrowserStream();
    }
    else {
        stopLiveBrowserStream();
        dom.liveBrowserImg.style.display = 'none';
        dom.liveViewportSurface.style.display = 'none';
        dom.browserAgentBanner.classList.remove('visible');
        const hasFrame = state.browserMode === 'url' || state.browserMode === 'srcdoc';
        loadPersistedFrameRestoreCandidate();
        dom.browserEmpty.style.display = hasFrame || Boolean(frameNav.pendingRestoreUrl) ? 'none' : 'flex';
        dom.browserFrame.style.display = hasFrame ? 'block' : 'none';
    }
    syncFrameNavIndicators();
}
const FRAME_HISTORY_KEY = 'causyne/web/frameLastUrl/v1';
const MAX_FRAME_HISTORY = 100;
const frameNav = {
    entries: [],
    index: -1,
    revision: 0,
    loadsForRevision: 0,
    originUnknown: false,
    pendingRestoreUrl: null
};
function syncFrameNavIndicators() {
    const isFrame = state.browserEngine === 'frame';
    if (dom.browserOriginBadge) {
        dom.browserOriginBadge.classList.toggle('visible', isFrame && frameNav.originUnknown);
    }
    if (dom.browserRestoreCard) {
        const showRestore = isFrame && state.browserMode === 'empty' && Boolean(frameNav.pendingRestoreUrl);
        dom.browserRestoreCard.classList.toggle('visible', showRestore);
        if (dom.browserRestoreUrl && showRestore) {
            dom.browserRestoreUrl.textContent = frameNav.pendingRestoreUrl || '';
        }
        if (showRestore) {
            dom.browserEmpty.style.display = 'none';
        }
    }
    if (isFrame) {
        dom.browserBackBtn.disabled = frameNav.originUnknown || frameNav.index <= 0;
        dom.browserFwdBtn.disabled = frameNav.originUnknown || frameNav.index < 0 || frameNav.index >= frameNav.entries.length - 1;
    }
    else {
        dom.browserBackBtn.disabled = false;
        dom.browserFwdBtn.disabled = false;
    }
}
function loadPersistedFrameRestoreCandidate() {
    if (frameNav.pendingRestoreUrl !== null || state.browserMode !== 'empty')
        return;
    try {
        const saved = window.localStorage.getItem(FRAME_HISTORY_KEY);
        if (saved) {
            const valid = parseLoopbackUrl(saved);
            if (valid && new URL(valid).origin !== window.location.origin) {
                frameNav.pendingRestoreUrl = valid;
            }
        }
    }
    catch {
        // Ignore storage errors
    }
}
function navigateFrameToIndex(nextIndex) {
    const url = frameNav.entries[nextIndex];
    if (!url)
        return;
    frameNav.index = nextIndex;
    frameNav.revision += 1;
    frameNav.loadsForRevision = 0;
    frameNav.originUnknown = false;
    state.browserMode = 'url';
    state.browserUrl = url;
    state.browserSrcdoc = '';
    dom.browserUrlInput.value = url;
    dom.browserEmpty.style.display = 'none';
    dom.browserFrame.style.display = 'block';
    dom.browserFrame.removeAttribute('srcdoc');
    dom.browserFrame.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin');
    dom.browserFrame.src = url;
    dom.browserOpenExtBtn.style.display = 'flex';
    syncFrameNavIndicators();
}
export function openBrowserUrl(rawUrl) {
    const valid = parseLoopbackUrl(rawUrl);
    if (!valid) {
        announceAlert('Only http://127.0.0.1 or http://localhost URLs are allowed in static preview.');
        return;
    }
    try {
        if (new URL(valid).origin === window.location.origin) {
            announceAlert('Refusing to embed Causyne Studio inside itself.');
            return;
        }
    }
    catch {
        return;
    }
    openStudio('browser');
    setBrowserEngine('frame');
    frameNav.pendingRestoreUrl = null;
    if (frameNav.index < frameNav.entries.length - 1) {
        frameNav.entries = frameNav.entries.slice(0, frameNav.index + 1);
    }
    if (frameNav.entries[frameNav.entries.length - 1] !== valid) {
        frameNav.entries.push(valid);
        if (frameNav.entries.length > MAX_FRAME_HISTORY) {
            frameNav.entries.shift();
        }
    }
    try {
        window.localStorage.setItem(FRAME_HISTORY_KEY, valid);
    }
    catch { /* ignore */ }
    navigateFrameToIndex(frameNav.entries.length - 1);
}
export function openBrowserArtifact(title, htmlOrSvg) {
    openStudio('browser');
    setBrowserEngine('frame');
    state.browserMode = 'srcdoc';
    state.browserUrl = '';
    const trimmed = String(htmlOrSvg || '').trim();
    const wrapped = trimmed.startsWith('<svg')
        ? `<!DOCTYPE html><html><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#141714">${trimmed}</body></html>`
        : trimmed;
    state.browserSrcdoc = wrapped;
    dom.browserUrlInput.value = title || 'preview.html';
    dom.browserEmpty.style.display = 'none';
    dom.browserFrame.style.display = 'block';
    dom.browserFrame.removeAttribute('src');
    dom.browserFrame.setAttribute('sandbox', 'allow-scripts');
    dom.browserFrame.srcdoc = wrapped;
    dom.browserOpenExtBtn.style.display = 'none';
}
async function sendLiveInput(payload) {
    if (!state.liveBrowserActive) {
        await runBrowserAction(Object.assign({ action: payload.kind }, payload));
        return;
    }
    if (state.liveStreamConnected) {
        await fetch(apiUrl('/api/browser/input'), {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(payload)
        }).catch(() => null);
    }
    else {
        await runBrowserAction(Object.assign({ action: payload.kind }, payload));
    }
}
async function syncChromeTab(port, targetId, includeCookies) {
    dom.cdpSyncStatus.textContent = includeCookies ? 'Importing tab and session...' : 'Opening tab...';
    const res = await fetch(apiUrl('/api/browser/cdp/sync'), {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ port, targetId, includeCookies })
    }).catch(() => null);
    if (!res) {
        dom.cdpSyncStatus.textContent = 'Import failed.';
        return;
    }
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) {
        dom.cdpSyncStatus.textContent = data.error || 'Import failed.';
        return;
    }
    setBrowserEngine('agent');
    applyLiveBrowserFrame(data);
    dom.cdpSyncStatus.textContent = `Imported ${data.syncedUrl || 'tab'}`;
}
async function scanLocalChromeTabs() {
    const port = Number(dom.cdpPortInput.value || 9222);
    dom.cdpSyncStatus.textContent = `Checking port ${port}...`;
    dom.cdpTabsList.textContent = '';
    const res = await fetch(apiUrl(`/api/browser/cdp/tabs?port=${encodeURIComponent(String(port))}`), { headers: authHeaders() }).catch(() => null);
    if (!res || !res.ok) {
        dom.cdpSyncStatus.textContent = `No Chrome debugging port found on ${port}. Start Chrome with --remote-debugging-port=${port}`;
        return;
    }
    const data = await res.json();
    const tabs = data.tabs || [];
    dom.cdpSyncStatus.textContent = `${tabs.length} open tab(s) on port ${data.port}`;
    for (const tab of tabs) {
        const row = document.createElement('div');
        row.className = 'sync-row';
        const title = document.createElement('span');
        title.className = 'sync-tab-title';
        title.textContent = tab.title || tab.url || '';
        const openOnly = document.createElement('button');
        openOnly.type = 'button';
        openOnly.className = 'btn-ghost';
        openOnly.textContent = 'Open';
        openOnly.addEventListener('click', () => { void syncChromeTab(data.port, tab.id, false); });
        const syncBtn = document.createElement('button');
        syncBtn.type = 'button';
        syncBtn.className = 'btn-primary';
        syncBtn.textContent = 'Import tab';
        syncBtn.addEventListener('click', () => { void syncChromeTab(data.port, tab.id, true); });
        row.appendChild(title);
        row.appendChild(openOnly);
        row.appendChild(syncBtn);
        dom.cdpTabsList.appendChild(row);
    }
}
async function importExplicitBrowserData() {
    const rawText = (dom.browserImportInput.value || '').trim();
    if (!rawText) {
        dom.cdpSyncStatus.textContent = 'Paste URLs, Bookmarks HTML, or storageState JSON first.';
        return;
    }
    dom.cdpSyncStatus.textContent = 'Importing...';
    const res = await fetch(apiUrl('/api/browser/import'), {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ rawText, openFirstUrl: true })
    }).catch(() => null);
    if (!res) {
        dom.cdpSyncStatus.textContent = 'Import failed.';
        return;
    }
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) {
        dom.cdpSyncStatus.textContent = data.error || 'Import failed.';
        return;
    }
    setBrowserEngine('agent');
    applyLiveBrowserFrame(data);
    dom.browserImportInput.value = '';
    dom.cdpSyncStatus.textContent = `Imported ${(data.importedUrls || []).length} URL(s), ${data.importedCookies || 0} cookie(s).`;
}
export function bindBrowserPanelEvents() {
    dom.browserMoreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasOpen = dom.browserMorePopover.classList.contains('open');
        closeAllPopovers();
        if (!wasOpen) {
            dom.browserMoreBtn.setAttribute('aria-expanded', 'true');
            positionPopover(dom.browserMorePopover, dom.browserMoreBtn, false);
        }
    });
    dom.bmodeAgentBtn.addEventListener('click', () => { closeAllPopovers(); setBrowserEngine('agent'); });
    dom.bmodeFrameBtn.addEventListener('click', () => { closeAllPopovers(); setBrowserEngine('frame'); });
    dom.browserStartBtn.addEventListener('click', () => {
        setBrowserEngine('agent');
        void runBrowserAction({ action: 'start' }).then(() => {
            startLiveBrowserStream();
            dom.liveViewportSurface.focus();
        });
    });
    dom.browserStartNativeBtn.addEventListener('click', () => {
        setBrowserEngine('agent');
        void runBrowserAction({ action: 'setMode', visible: true, ensureStarted: true }).then(() => startLiveBrowserStream());
    });
    dom.browserNativeWinBtn.addEventListener('click', () => {
        setBrowserEngine('agent');
        const nextVisible = !state.liveBrowserVisible;
        void runBrowserAction({ action: 'setMode', visible: nextVisible, ensureStarted: true }).then(() => startLiveBrowserStream());
    });
    dom.browserEngineSelect.addEventListener('change', () => {
        const pref = dom.browserEngineSelect.value || 'auto';
        void runBrowserAction({ action: 'setMode', enginePreference: pref, ensureStarted: state.liveBrowserActive });
    });
    dom.browserCloseEngineBtn.addEventListener('click', () => {
        closeAllPopovers();
        void runBrowserAction({ action: 'close' });
    });
    dom.browserHandoffBtn.addEventListener('click', () => {
        closeAllPopovers();
        const nextAction = state.controlOwner === 'agent' ? 'takeControl' : 'handToAgent';
        void runBrowserAction({ action: nextAction });
    });
    dom.bannerTakeControlBtn.addEventListener('click', () => {
        void runBrowserAction({ action: 'takeControl' }).then(() => dom.liveViewportSurface.focus());
    });
    dom.browserSyncToggleBtn.addEventListener('click', () => {
        const open = dom.browserSyncDrawer.classList.toggle('open');
        dom.browserSyncToggleBtn.classList.toggle('active', open);
        if (open)
            void scanLocalChromeTabs();
    });
    dom.cdpScanBtn.addEventListener('click', () => { void scanLocalChromeTabs(); });
    dom.browserImportBtn.addEventListener('click', () => { void importExplicitBrowserData(); });
    dom.browserNewTabBtn.addEventListener('click', () => { void runBrowserAction({ action: 'newTab' }); });
    dom.browserBackBtn.addEventListener('click', () => {
        if (state.browserEngine === 'frame') {
            if (!frameNav.originUnknown && frameNav.index > 0)
                navigateFrameToIndex(frameNav.index - 1);
            return;
        }
        void runBrowserAction({ action: 'back' });
    });
    dom.browserFwdBtn.addEventListener('click', () => {
        if (state.browserEngine === 'frame') {
            if (!frameNav.originUnknown && frameNav.index >= 0 && frameNav.index < frameNav.entries.length - 1) {
                navigateFrameToIndex(frameNav.index + 1);
            }
            return;
        }
        void runBrowserAction({ action: 'forward' });
    });
    dom.browserFrame.addEventListener('load', () => {
        if (state.browserEngine !== 'frame' || state.browserMode !== 'url')
            return;
        frameNav.loadsForRevision += 1;
        if (frameNav.loadsForRevision > 1) {
            frameNav.originUnknown = true;
            syncFrameNavIndicators();
        }
    });
    dom.browserRestoreBtn?.addEventListener('click', () => {
        const url = frameNav.pendingRestoreUrl;
        frameNav.pendingRestoreUrl = null;
        if (url)
            openBrowserUrl(url);
        else
            syncFrameNavIndicators();
    });
    dom.browserRestoreDismissBtn?.addEventListener('click', () => {
        frameNav.pendingRestoreUrl = null;
        try {
            window.localStorage.removeItem(FRAME_HISTORY_KEY);
        }
        catch { /* ignore */ }
        dom.browserEmpty.style.display = 'flex';
        syncFrameNavIndicators();
    });
    const triggerNavigate = () => {
        const val = (dom.browserUrlInput.value || '').trim();
        if (state.browserEngine === 'agent') {
            void runBrowserAction({ action: 'goto', url: val }).then(() => startLiveBrowserStream());
        }
        else {
            openBrowserUrl(val);
        }
    };
    dom.browserUrlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            triggerNavigate();
        }
    });
    dom.browserReloadBtn.addEventListener('click', () => {
        if (state.browserEngine === 'agent') {
            void runBrowserAction({ action: 'reload' });
            return;
        }
        if (state.browserMode === 'url' && state.browserUrl)
            dom.browserFrame.src = state.browserUrl;
        else if (state.browserMode === 'srcdoc' && state.browserSrcdoc)
            dom.browserFrame.srcdoc = state.browserSrcdoc;
    });
    const mapViewportCoords = (e) => {
        const rect = dom.liveBrowserImg.getBoundingClientRect();
        if (!rect.width || !rect.height)
            return null;
        return {
            x: Math.round(((e.clientX - rect.left) / rect.width) * state.liveBrowserWidth),
            y: Math.round(((e.clientY - rect.top) / rect.height) * state.liveBrowserHeight)
        };
    };
    const mapMouseButton = (btn) => (btn === 2 ? 'right' : btn === 1 ? 'middle' : 'left');
    let lastMoveSent = 0;
    dom.liveBrowserImg.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        dom.liveViewportSurface.focus();
        const pt = mapViewportCoords(e);
        if (!pt)
            return;
        state.pointerDragging = true;
        void sendLiveInput({ kind: 'mousedown', x: pt.x, y: pt.y, button: mapMouseButton(e.button) });
    });
    dom.liveBrowserImg.addEventListener('pointermove', (e) => {
        const now = Date.now();
        if (!state.pointerDragging && document.activeElement !== dom.liveViewportSurface)
            return;
        if (now - lastMoveSent < (state.pointerDragging ? 35 : 90))
            return;
        lastMoveSent = now;
        const pt = mapViewportCoords(e);
        if (pt)
            void sendLiveInput({ kind: 'mousemove', x: pt.x, y: pt.y });
    });
    dom.liveBrowserImg.addEventListener('pointerup', (e) => {
        if (!state.pointerDragging)
            return;
        state.pointerDragging = false;
        const pt = mapViewportCoords(e);
        if (pt)
            void sendLiveInput({ kind: 'mouseup', x: pt.x, y: pt.y, button: mapMouseButton(e.button) });
    });
    dom.liveBrowserImg.addEventListener('dblclick', (e) => {
        e.preventDefault();
        const pt = mapViewportCoords(e);
        if (pt)
            void sendLiveInput({ kind: 'dblclick', x: pt.x, y: pt.y });
    });
    dom.liveBrowserImg.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const pt = mapViewportCoords(e);
        if (pt)
            void sendLiveInput({ kind: 'contextmenu', x: pt.x, y: pt.y, button: 'right' });
    });
    let wheelTimer = null;
    let wheelDx = 0;
    let wheelDy = 0;
    dom.liveBrowserImg.addEventListener('wheel', (e) => {
        e.preventDefault();
        wheelDx += e.deltaX;
        wheelDy += e.deltaY;
        if (wheelTimer)
            return;
        wheelTimer = setTimeout(() => {
            const dx = Math.round(wheelDx);
            const dy = Math.round(wheelDy);
            wheelDx = 0;
            wheelDy = 0;
            wheelTimer = null;
            void sendLiveInput({ kind: 'wheel', deltaX: dx, deltaY: dy });
        }, 60);
    }, { passive: false });
    const keyMap = {
        Enter: 'Enter', Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab', Escape: 'Escape',
        ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
        Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown'
    };
    dom.liveViewportSurface.addEventListener('keydown', (e) => {
        if (!state.liveBrowserActive || state.browserEngine !== 'agent')
            return;
        const mod = e.metaKey || e.ctrlKey;
        if (mod && e.key.toLowerCase() === 'v')
            return;
        e.preventDefault();
        e.stopPropagation();
        if (mod && e.key.length === 1) {
            const prefix = e.metaKey ? 'Meta+' : 'Control+';
            void sendLiveInput({ kind: 'key', key: prefix + e.key.toLowerCase() });
            return;
        }
        if (e.key.length === 1 && !e.altKey) {
            void sendLiveInput({ kind: 'type', text: e.key });
            return;
        }
        const mapped = keyMap[e.key];
        if (mapped)
            void sendLiveInput({ kind: 'key', key: mapped });
    });
    dom.liveViewportSurface.addEventListener('paste', (e) => {
        if (!state.liveBrowserActive || state.browserEngine !== 'agent')
            return;
        const txt = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
        if (!txt)
            return;
        e.preventDefault();
        void sendLiveInput({ kind: 'paste', text: txt });
    });
    dom.browserSnapshotBtn.addEventListener('click', async () => {
        closeAllPopovers();
        const data = await runBrowserAction({ action: 'snapshot' });
        if (data && data.snapshot) {
            openStudio('cli');
            dom.cliConsoleEl.textContent = data.snapshot;
            dom.cliStatusEl.textContent = `Page structure (${data.refsCount || 0} interactive elements)`;
        }
    });
    dom.browserDemoBtn.addEventListener('click', () => {
        closeAllPopovers();
        setBrowserEngine('frame');
        const content = (dom.fileContentInput.value || '').trim();
        if (content && (content.startsWith('<') || isHtmlOrSvgPath(dom.filePathInput.value))) {
            openBrowserArtifact(dom.filePathInput.value || 'preview.html', content);
        }
        else {
            openBrowserArtifact('preview.html', '<!DOCTYPE html><html><body style="margin:0;padding:32px;background:#141714;color:#ecefe9;font-family:system-ui">'
                + '<h2 style="margin:0 0 8px;font-weight:500">Document preview</h2>'
                + '<p style="color:#a0a79c">Open an HTML or SVG file in the Editor to preview it here.</p></body></html>');
        }
    });
    dom.browserOpenExtBtn.addEventListener('click', () => {
        closeAllPopovers();
        const valid = parseLoopbackUrl(state.browserUrl);
        if (valid)
            window.open(valid, '_blank', 'noopener,noreferrer');
    });
    document.querySelectorAll('[data-vp]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const vp = btn.getAttribute('data-vp') || 'desktop';
            state.browserViewport = vp;
            document.querySelectorAll('[data-vp]').forEach((b) => b.classList.toggle('active', b === btn));
            dom.browserFrame.classList.toggle('vp-tablet', vp === 'tablet');
            dom.browserFrame.classList.toggle('vp-mobile', vp === 'mobile');
            if (state.browserEngine === 'agent' && state.liveBrowserActive) {
                const dims = vp === 'mobile'
                    ? { width: 390, height: 844 }
                    : vp === 'tablet'
                        ? { width: 768, height: 900 }
                        : { width: 1280, height: 800 };
                void runBrowserAction({ action: 'viewport', width: dims.width, height: dims.height });
            }
        });
    });
    window.addEventListener('beforeunload', stopLiveBrowserStream);
}
