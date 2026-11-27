import { dom } from './dom.js';
import { apiUrl, authHeaders, scrollToBottom, setLiveness, setStageMode, state, syncUsagePill, updateComposerMetrics } from './state.js';
import { renderAttachmentChips } from './composer.js';
import { loadFiles, setCanvasPreviewMode, syncArtifactVersionSelect } from './filesAndCanvas.js';
import { loadDiff, syncDiffControlsUi } from './diffPanel.js';
import { refreshLiveBrowserState, setBrowserEngine, startLiveBrowserStream } from './browserPanel.js';
import { loadCliOverview } from './cliPanel.js';
import { appendUserTurn, createAssistantTurn, resetThreadSpacer } from './turnView.js';
import { loadPermissionPresets, syncPermissionPresetLock } from './permissionPresetsUi.js';
let callbacks = {
    attachToActiveSessionStream: async () => { }
};
export function configureSessionsCallbacks(cbs) {
    callbacks = cbs;
}
function sessionKey(id) {
    return id || '__draft__';
}
function bucketLabel(ts) {
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayMs = 86400000;
    if (ts >= startToday)
        return 'Today';
    if (ts >= startToday - dayMs)
        return 'Yesterday';
    if (ts >= startToday - 7 * dayMs)
        return 'Previous 7 days';
    return 'Older';
}
function updateActiveSessionRow(activeId) {
    dom.sessionListEl.querySelectorAll('.session-item').forEach((elItem) => {
        elItem.classList.toggle('active', Boolean(activeId && elItem.dataset.sessionId === activeId));
    });
}
export function startInlineSessionRename(item, titleBtn, s) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'session-rename-input';
    input.value = s.title || '';
    input.maxLength = 80;
    titleBtn.style.display = 'none';
    item.insertBefore(input, titleBtn);
    input.focus();
    input.select();
    let finished = false;
    const finish = async (save) => {
        if (finished)
            return;
        finished = true;
        const next = (input.value || '').trim();
        input.remove();
        titleBtn.style.display = '';
        if (!save || !next || next === s.title)
            return;
        s.title = next;
        titleBtn.textContent = next;
        await fetch(apiUrl(`/api/sessions/${encodeURIComponent(s.id)}`), {
            method: 'PATCH',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ title: next })
        }).catch(() => { });
    };
    input.addEventListener('click', (ev) => ev.stopPropagation());
    input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
            ev.preventDefault();
            ev.stopPropagation();
            void finish(true);
        }
        else if (ev.key === 'Escape') {
            ev.preventDefault();
            ev.stopPropagation();
            void finish(false);
        }
    });
    input.addEventListener('blur', () => { void finish(true); });
}
export function renderSessionList() {
    const prevScroll = dom.sessionListEl.scrollTop;
    const q = (dom.sessionSearchEl.value || '').trim().toLowerCase();
    const filtered = state.sessions.filter((s) => !q || String(s.title || '').toLowerCase().includes(q));
    dom.sessionListEl.textContent = '';
    if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'session-empty';
        empty.textContent = q ? 'No matching chats.' : 'No saved workspace chats yet.';
        dom.sessionListEl.appendChild(empty);
        return;
    }
    let currentGroup = '';
    for (const s of filtered) {
        const grp = bucketLabel(s.updatedAt || s.createdAt || 0);
        if (grp !== currentGroup) {
            currentGroup = grp;
            const gl = document.createElement('div');
            gl.className = 'session-group-label';
            gl.textContent = grp;
            dom.sessionListEl.appendChild(gl);
        }
        const item = document.createElement('div');
        item.dataset.sessionId = s.id;
        item.className = `session-item${s.id === state.sessionId ? ' active' : ''}`;
        item.addEventListener('click', () => { void loadSessionTranscript(s.id); });
        if (s.running) {
            const dot = document.createElement('span');
            dot.className = `session-run-dot${s.awaitingClient ? ' awaiting' : ''}`;
            dot.title = s.awaitingClient ? 'Waiting for your input' : 'Running in background';
            item.appendChild(dot);
        }
        const titleBtn = document.createElement('button');
        titleBtn.type = 'button';
        titleBtn.className = 'session-title';
        titleBtn.textContent = s.title || 'Untitled';
        titleBtn.title = s.title || 'Untitled';
        const actions = document.createElement('div');
        actions.className = 'session-actions';
        const renBtn = document.createElement('button');
        renBtn.type = 'button';
        renBtn.className = 'mini-icon-btn';
        renBtn.textContent = 'R';
        renBtn.title = 'Rename';
        renBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            startInlineSessionRename(item, titleBtn, s);
        });
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'mini-icon-btn';
        delBtn.textContent = 'x';
        delBtn.title = 'Delete';
        delBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await fetch(apiUrl(`/api/sessions/${encodeURIComponent(s.id)}`), {
                method: 'DELETE',
                headers: authHeaders()
            }).catch(() => { });
            state.sessionWorkspaces.delete(s.id);
            if (state.sessionId === s.id)
                void startFreshChat();
            void loadSessions();
        });
        actions.appendChild(renBtn);
        actions.appendChild(delBtn);
        item.appendChild(titleBtn);
        item.appendChild(actions);
        dom.sessionListEl.appendChild(item);
    }
    dom.sessionListEl.scrollTop = prevScroll;
}
export async function loadSessions() {
    const res = await fetch(apiUrl('/api/sessions'), { headers: authHeaders() });
    if (!res.ok)
        return;
    const data = await res.json();
    state.sessions = data.sessions || [];
    renderSessionList();
}
export function saveCurrentSessionWorkspace() {
    const key = sessionKey(state.sessionId);
    state.sessionWorkspaces.set(key, {
        studioOpen: dom.appEl.classList.contains('studio-open'),
        studioTab: state.studioTab,
        canvasPath: dom.filePathInput.value || '',
        canvasContent: dom.fileContentInput.value || '',
        canvasPreviewMode: Boolean(state.canvasPreviewMode),
        canvasStatus: dom.fileStatusEl.textContent || 'Ready',
        canvasDirty: Boolean(state.canvasDirty),
        diffScope: state.diffScope,
        diffStaged: Boolean(state.diffStaged),
        attachments: state.attachments.slice(),
        draftPrompt: dom.promptInput.value || '',
        usageTokens: state.usageTokens,
        browserEngine: state.browserEngine,
        browserMode: state.browserMode,
        browserUrl: state.browserUrl,
        browserSrcdoc: state.browserSrcdoc,
        cliConsoleText: dom.cliConsoleEl.textContent || 'Select a command above or type /help.',
        cliStatusText: dom.cliStatusEl.textContent || 'Ready'
    });
}
export function applySessionWorkspace(nextSessionId) {
    const key = sessionKey(nextSessionId);
    const saved = state.sessionWorkspaces.get(key) || null;
    state.attachments = saved ? saved.attachments.slice() : [];
    renderAttachmentChips();
    dom.promptInput.value = saved ? saved.draftPrompt : '';
    updateComposerMetrics();
    syncUsagePill(saved ? saved.usageTokens : 0);
    dom.filePathInput.value = saved ? saved.canvasPath : '';
    dom.fileContentInput.value = saved ? saved.canvasContent : '';
    state.canvasDirty = saved ? Boolean(saved.canvasDirty) : false;
    dom.fileStatusEl.textContent = saved ? saved.canvasStatus : 'Ready';
    dom.canvasHtmlFrame.removeAttribute('srcdoc');
    dom.canvasPreviewEl.textContent = '';
    syncArtifactVersionSelect(dom.filePathInput.value.trim());
    setCanvasPreviewMode(saved ? Boolean(saved.canvasPreviewMode) : false);
    state.diffScope = saved ? saved.diffScope : (nextSessionId ? 'session' : 'workspace');
    state.diffStaged = saved ? Boolean(saved.diffStaged) : false;
    syncDiffControlsUi();
    dom.diffListEl.textContent = '';
    dom.diffSummaryEl.textContent = 'Loading...';
    dom.cliConsoleEl.textContent = saved ? saved.cliConsoleText : 'Select a command above or type /help.';
    dom.cliStatusEl.textContent = saved ? saved.cliStatusText : 'Ready';
    if (saved && saved.browserEngine === 'frame') {
        state.browserMode = saved.browserMode || 'empty';
        state.browserUrl = saved.browserUrl || '';
        state.browserSrcdoc = saved.browserSrcdoc || '';
        if (state.browserMode === 'srcdoc' && state.browserSrcdoc) {
            dom.browserFrame.removeAttribute('src');
            dom.browserFrame.srcdoc = state.browserSrcdoc;
        }
        else if (state.browserMode === 'url' && state.browserUrl) {
            dom.browserFrame.removeAttribute('srcdoc');
            dom.browserFrame.src = state.browserUrl;
        }
        else {
            dom.browserFrame.removeAttribute('srcdoc');
            dom.browserFrame.removeAttribute('src');
        }
        setBrowserEngine('frame');
    }
    else {
        state.browserMode = 'empty';
        state.browserUrl = '';
        state.browserSrcdoc = '';
        dom.browserFrame.removeAttribute('srcdoc');
        dom.browserFrame.removeAttribute('src');
        if (state.browserEngine === 'frame')
            setBrowserEngine('agent');
    }
    if (dom.appEl.classList.contains('studio-open')) {
        if (state.studioTab === 'diff')
            void loadDiff();
        else if (state.studioTab === 'files')
            void loadFiles(state.currentDir, dom.fileFilterEl.value || '');
        else if (state.studioTab === 'cli')
            void loadCliOverview();
        else if (state.studioTab === 'browser' && state.browserEngine === 'agent') {
            void refreshLiveBrowserState(false);
            startLiveBrowserStream();
        }
    }
}
export function detachLocalStreamReader() {
    if (state.activeController) {
        try {
            state.activeController.abort();
        }
        catch { /* ignore */ }
        state.activeController = null;
    }
    state.activeTurn = null;
    state.activePrompt = '';
    setLiveness(false, '');
    syncPermissionPresetLock(false);
    updateComposerMetrics();
}
export async function loadSessionTranscript(id) {
    if (!id)
        return;
    detachLocalStreamReader();
    saveCurrentSessionWorkspace();
    const seq = ++state.sessionSwitchSeq;
    state.sessionId = id;
    updateActiveSessionRow(id);
    applySessionWorkspace(id);
    void loadPermissionPresets(id);
    if (window.innerWidth <= 960)
        dom.appEl.classList.add('sidebar-collapsed');
    const res = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(id)}`), { headers: authHeaders() }).catch(() => null);
    if (seq !== state.sessionSwitchSeq)
        return;
    if (!res || !res.ok) {
        dom.threadEl.textContent = '';
        resetThreadSpacer();
        setStageMode(true);
        const errTurn = createAssistantTurn('');
        errTurn.addError(res && res.status === 401
            ? 'Session authentication expired. Reopen the URL printed by `causyne web`.'
            : `Could not load conversation (HTTP ${res ? res.status : 'network error'}).`);
        return;
    }
    const data = await res.json().catch(() => null);
    const sess = data?.session;
    if (!sess || seq !== state.sessionSwitchSeq)
        return;
    dom.threadEl.textContent = '';
    resetThreadSpacer();
    dom.threadEl.classList.remove('chat-fade-in');
    void dom.threadEl.offsetWidth;
    dom.threadEl.classList.add('chat-fade-in');
    const msgs = sess.messages || [];
    setStageMode(msgs.length > 0 || Boolean(sess.running));
    let lastUserPrompt = '';
    for (const m of msgs) {
        if (m.role === 'user') {
            lastUserPrompt = m.content || '';
            appendUserTurn(lastUserPrompt, [], false);
        }
        else {
            const t = createAssistantTurn(lastUserPrompt, { restored: true });
            if (Array.isArray(m.blocks) && m.blocks.length > 0) {
                t.renderRestoredBlocks(m.blocks);
            }
            else {
                if (m.reasoning)
                    t.updateReasoning({ content: m.reasoning, streaming: false });
                if (Array.isArray(m.steps)) {
                    for (const st of m.steps) {
                        t.addNativeStep({ actionName: st.tool || '', detail: st.target || st.output || '', message: st.tool || '' }, st.status === 'failed');
                    }
                }
                if (m.content)
                    t.setText(m.content, false);
            }
            t.finish();
        }
    }
    if (sess.running && sess.activeRun) {
        const runPrompt = sess.activeRun.prompt || lastUserPrompt;
        const lastMsg = msgs[msgs.length - 1];
        if (runPrompt && (!lastMsg || lastMsg.role !== 'user' || lastMsg.content !== runPrompt)) {
            appendUserTurn(runPrompt, [], false);
        }
        scrollToBottom(true);
        void callbacks.attachToActiveSessionStream(id, runPrompt, seq);
        return;
    }
    const tailMsg = msgs[msgs.length - 1];
    if (tailMsg && tailMsg.role === 'user') {
        const interruptedTurn = createAssistantTurn(lastUserPrompt, { restored: true });
        interruptedTurn.addInterrupted('Causyne\u2019s response was interrupted.', lastUserPrompt);
        interruptedTurn.finish();
    }
    scrollToBottom(true);
}
export async function startFreshChat() {
    detachLocalStreamReader();
    saveCurrentSessionWorkspace();
    state.sessionSwitchSeq += 1;
    state.sessionWorkspaces.delete('__draft__');
    state.sessionId = null;
    dom.threadEl.textContent = '';
    resetThreadSpacer();
    setStageMode(false);
    applySessionWorkspace(null);
    updateActiveSessionRow(null);
    void loadPermissionPresets(null);
    dom.promptInput.focus();
    if (window.innerWidth <= 960)
        dom.appEl.classList.add('sidebar-collapsed');
}
