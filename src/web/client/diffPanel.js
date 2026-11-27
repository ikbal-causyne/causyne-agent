import { dom } from './dom.js';
import { apiUrl, authHeaders, state } from './state.js';
let callbacks = {
    openFile: async () => { },
    saveCurrentSessionWorkspace: () => { }
};
export function configureDiffPanelCallbacks(cbs) {
    callbacks = cbs;
}
export function syncDiffControlsUi() {
    const isSessionScope = state.diffScope === 'session' && Boolean(state.sessionId);
    if (dom.diffScopeSessionBtn) {
        dom.diffScopeSessionBtn.classList.toggle('active', isSessionScope);
        dom.diffScopeSessionBtn.disabled = !state.sessionId;
    }
    if (dom.diffScopeWorkspaceBtn) {
        dom.diffScopeWorkspaceBtn.classList.toggle('active', !isSessionScope);
    }
    if (dom.diffStagedToggle) {
        dom.diffStagedToggle.style.display = isSessionScope ? 'none' : 'inline-block';
        dom.diffStagedToggle.textContent = state.diffStaged ? 'Staged' : 'Working';
    }
}
export async function loadDiff() {
    const seq = state.sessionSwitchSeq;
    const scope = state.diffScope === 'session' && state.sessionId ? 'session' : 'workspace';
    syncDiffControlsUi();
    const params = new URLSearchParams();
    params.set('scope', scope);
    if (state.sessionId)
        params.set('sessionId', state.sessionId);
    if (scope === 'workspace' && state.diffStaged)
        params.set('staged', '1');
    const res = await fetch(apiUrl(`/api/diff?${params.toString()}`), { headers: authHeaders() }).catch(() => null);
    if (!res || !res.ok || seq !== state.sessionSwitchSeq)
        return;
    const data = await res.json().catch(() => null);
    if (!data || seq !== state.sessionSwitchSeq)
        return;
    dom.diffListEl.textContent = '';
    const wsCount = Number(data.workspaceFileCount || 0);
    const sessCount = Number(data.sessionFileCount || 0);
    if (dom.diffScopeSessionBtn) {
        dom.diffScopeSessionBtn.textContent = state.sessionId ? `This chat (${sessCount})` : 'This chat';
    }
    if (dom.diffScopeWorkspaceBtn) {
        dom.diffScopeWorkspaceBtn.textContent = `Workspace (${wsCount})`;
    }
    if (!data.isGitRepo && scope === 'workspace') {
        dom.diffSummaryEl.textContent = 'Not a Git repository.';
        return;
    }
    const files = data.files || [];
    const addTot = Number(data.totalAdditions || 0);
    const delTot = Number(data.totalDeletions || 0);
    dom.diffSummaryEl.textContent = (addTot || delTot)
        ? `+${addTot} / -${delTot}`
        : (files.length > 0 ? `${files.length}${files.length === 1 ? ' file' : ' files'}` : '');
    if (files.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'diff-empty-box';
        const activeSessObj = state.sessions.find((x) => x.id === state.sessionId);
        const activeTitle = activeSessObj && activeSessObj.title
            ? `"${activeSessObj.title.slice(0, 48)}"`
            : 'this conversation';
        const msg = document.createElement('div');
        msg.textContent = scope === 'session'
            ? `No file changes in ${activeTitle}.`
            : (state.diffStaged ? 'No staged changes.' : 'Working tree clean.');
        empty.appendChild(msg);
        if (scope === 'session' && wsCount > 0) {
            const switchBtn = document.createElement('button');
            switchBtn.type = 'button';
            switchBtn.className = 'btn-ghost';
            switchBtn.textContent = `View workspace changes (${wsCount})`;
            switchBtn.addEventListener('click', () => {
                state.diffScope = 'workspace';
                callbacks.saveCurrentSessionWorkspace();
                syncDiffControlsUi();
                void loadDiff();
            });
            empty.appendChild(switchBtn);
        }
        dom.diffListEl.appendChild(empty);
        return;
    }
    for (const f of files) {
        const card = document.createElement('details');
        card.className = 'diff-file';
        card.open = files.length <= 6;
        const head = document.createElement('summary');
        head.className = 'diff-file-head';
        const p = document.createElement('span');
        p.className = 'diff-file-path';
        p.title = f.path;
        const badgeChar = f.status && f.status[0] ? f.status[0].toUpperCase() : 'M';
        p.textContent = `[${badgeChar}] ${f.path}`;
        const right = document.createElement('span');
        right.className = 'diff-file-right';
        if (f.additions || f.deletions) {
            const add = document.createElement('span');
            add.className = 'diff-add';
            add.textContent = `+${f.additions || 0}`;
            const del = document.createElement('span');
            del.className = 'diff-del';
            del.textContent = `-${f.deletions || 0}`;
            right.appendChild(add);
            right.appendChild(del);
        }
        if (f.existsOnDisk !== false) {
            const openBtn = document.createElement('button');
            openBtn.type = 'button';
            openBtn.className = 'diff-open-btn';
            openBtn.textContent = 'Open';
            openBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                void callbacks.openFile(f.path);
            });
            right.appendChild(openBtn);
        }
        head.appendChild(p);
        head.appendChild(right);
        card.appendChild(head);
        if (Array.isArray(f.hunks) && f.hunks.length > 0) {
            const pre = document.createElement('div');
            pre.className = 'diff-lines';
            for (const h of f.hunks) {
                const hh = document.createElement('div');
                hh.className = 'diff-line hunk';
                hh.textContent = h.header;
                pre.appendChild(hh);
                for (const ln of h.lines || []) {
                    const row = document.createElement('div');
                    row.className = `diff-line${ln.startsWith('+') ? ' plus' : ln.startsWith('-') ? ' minus' : ''}`;
                    row.textContent = ln;
                    pre.appendChild(row);
                }
            }
            card.appendChild(pre);
        }
        else if (f.note) {
            const note = document.createElement('div');
            note.className = 'diff-note';
            note.textContent = f.note;
            card.appendChild(note);
        }
        dom.diffListEl.appendChild(card);
    }
}
export function bindDiffPanelEvents() {
    if (dom.diffScopeSessionBtn) {
        dom.diffScopeSessionBtn.addEventListener('click', () => {
            if (!state.sessionId)
                return;
            state.diffScope = 'session';
            callbacks.saveCurrentSessionWorkspace();
            syncDiffControlsUi();
            void loadDiff();
        });
    }
    if (dom.diffScopeWorkspaceBtn) {
        dom.diffScopeWorkspaceBtn.addEventListener('click', () => {
            state.diffScope = 'workspace';
            callbacks.saveCurrentSessionWorkspace();
            syncDiffControlsUi();
            void loadDiff();
        });
    }
    dom.diffStagedToggle.addEventListener('click', () => {
        state.diffStaged = !state.diffStaged;
        syncDiffControlsUi();
        void loadDiff();
    });
    dom.refreshDiffBtn.addEventListener('click', () => { void loadDiff(); });
}
