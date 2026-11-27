import { announceStatus, dom } from './dom.js';
import { apiUrl, authHeaders, setLiveness, state, syncUsagePill, updateComposerMetrics } from './state.js';
import { openStudio } from './studioShell.js';
import { refreshLiveBrowserState, setBrowserEngine } from './browserPanel.js';
import { loadFiles } from './filesAndCanvas.js';
import { loadDiff, syncDiffControlsUi } from './diffPanel.js';
import { appendUserTurn, createAssistantTurn } from './turnView.js';
import { loadSessionTranscript, loadSessions } from './sessions.js';
import { presetToLegacyMode, syncPermissionPresetLock } from './permissionPresetsUi.js';
export async function stopActiveRun() {
    const sid = state.sessionId || undefined;
    const ctrl = state.activeController;
    const turn = state.activeTurn;
    const promptCopy = state.activePrompt;
    await fetch(apiUrl('/api/stop'), {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ sessionId: sid })
    }).catch(() => { });
    const waitStart = Date.now();
    while (ctrl && state.activeController === ctrl && (Date.now() - waitStart) < 400) {
        await new Promise((r) => setTimeout(r, 40));
    }
    if (ctrl && state.activeController === ctrl) {
        try {
            ctrl.abort();
        }
        catch { /* ignore */ }
        state.activeController = null;
        state.activeTurn = null;
        state.activePrompt = '';
        if (turn) {
            turn.addInterrupted('You stopped Causyne\u2019s response.', promptCopy);
            turn.finish();
        }
    }
    setLiveness(false, '');
    syncPermissionPresetLock(false);
    updateComposerMetrics();
    announceStatus('Response stopped.');
    void loadSessions();
}
export async function consumeNdjsonStream(res, assistant, runSeq, promptForRetry) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let receivedTerminal = false;
    let receivedIdle = false;
    while (true) {
        const step = await reader.read();
        if (step.done)
            break;
        if (runSeq !== state.sessionSwitchSeq)
            break;
        buf += decoder.decode(step.value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
            if (!line.trim())
                continue;
            let ev = null;
            try {
                ev = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (!ev)
                continue;
            if (ev.type === 'heartbeat') {
                continue;
            }
            else if (ev.type === 'idle') {
                receivedIdle = true;
                receivedTerminal = true;
                continue;
            }
            else if (ev.type === 'session_bound' && ev.sessionId) {
                const prevDraft = state.sessionWorkspaces.get('__draft__');
                if (prevDraft && !state.sessionId) {
                    state.sessionWorkspaces.set(ev.sessionId, prevDraft);
                    state.sessionWorkspaces.delete('__draft__');
                }
                state.sessionId = ev.sessionId;
                syncDiffControlsUi();
                void loadSessions();
            }
            else if (ev.type === 'agent_reasoning' || ev.type === 'reasoning_chunk') {
                assistant.updateReasoning(ev);
                setLiveness(true, 'Reasoning...');
            }
            else if (ev.type === 'agent_plan') {
                assistant.updatePlan(ev);
            }
            else if (ev.type === 'status' && ev.message) {
                setLiveness(true, ev.message);
            }
            else if (ev.type === 'agent_activity' && ev.activity) {
                setLiveness(true, ev.activity);
            }
            else if (ev.type === 'step_start' || ev.type === 'tool_start') {
                assistant.addStepStart(ev);
                if (String(ev.tool || '').toLowerCase().includes('browser')) {
                    openStudio('browser');
                    setBrowserEngine('agent');
                }
            }
            else if (ev.type === 'step_complete' || ev.type === 'tool_result') {
                assistant.addStepEnd(ev, ev.success === false);
                const tLow = String(ev.tool || '').toLowerCase();
                if (tLow.includes('browser')) {
                    void refreshLiveBrowserState(false);
                }
                else if (dom.appEl.classList.contains('studio-open')
                    && state.studioTab === 'diff'
                    && /(write|edit|patch|delete|move|forge)/.test(tLow)) {
                    void loadDiff();
                }
            }
            else if (ev.type === 'step_error') {
                assistant.addStepEnd(ev, true);
            }
            else if (ev.type === 'code_progress') {
                assistant.upsertCodeProgress(ev);
                if (ev.phase === 'done' && dom.appEl.classList.contains('studio-open') && state.studioTab === 'diff') {
                    void loadDiff();
                }
            }
            else if (ev.type === 'approval_request') {
                assistant.addApproval(ev);
            }
            else if (ev.type === 'decision_request' && ev.request) {
                assistant.addDecision(ev.request);
            }
            else if (ev.type === 'usage_update') {
                const total = Number(ev.totalTokens || ev.sessionTokens || ev.promptTokens || 0);
                if (total > 0)
                    syncUsagePill(total);
            }
            else if (ev.type === 'agent_chunk' && ev.delta) {
                assistant.appendText(ev.delta);
                setLiveness(true, 'Responding...');
            }
            else if (ev.type === 'agent_message' && typeof ev.content === 'string') {
                assistant.setText(ev.content, Boolean(ev.streaming));
                setLiveness(Boolean(ev.streaming), ev.streaming ? 'Responding...' : '');
            }
            else if ((ev.type === 'notice' || ev.type === 'budget_warning' || ev.type === 'warning') && ev.message) {
                if (ev.nativeStep === true) {
                    assistant.addNativeStep(ev, ev.type === 'warning' || ev.nativeFailed === true);
                    const actLower = String(ev.actionName || ev.message || '').toLowerCase();
                    if (actLower.includes('browser')) {
                        openStudio('browser');
                        void refreshLiveBrowserState(false);
                    }
                    else if (dom.appEl.classList.contains('studio-open')
                        && state.studioTab === 'diff'
                        && /(write|edit|patch|delete|move)/.test(actLower)) {
                        void loadDiff();
                    }
                }
                else {
                    assistant.addNotice(ev.message);
                }
            }
            else if (ev.type === 'stopped') {
                receivedTerminal = true;
                assistant.addInterrupted('You stopped Causyne\u2019s response.', promptForRetry);
            }
            else if (ev.type === 'done') {
                receivedTerminal = true;
            }
            else if (ev.type === 'error') {
                receivedTerminal = true;
                assistant.addError(ev.message || 'Task error.', promptForRetry, ev.code || '');
            }
        }
    }
    return { receivedTerminal, receivedIdle };
}
export async function attachToActiveSessionStream(sessionId, promptForRetry, runSeq) {
    const assistant = createAssistantTurn(promptForRetry);
    const controller = new AbortController();
    state.activeController = controller;
    state.activeTurn = assistant;
    state.activePrompt = promptForRetry || '';
    syncPermissionPresetLock(true);
    updateComposerMetrics();
    setLiveness(true, 'Continuing in background...');
    let shouldReloadFinished = false;
    try {
        const res = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/stream`), {
            headers: authHeaders(),
            signal: controller.signal
        });
        if (runSeq !== state.sessionSwitchSeq)
            return;
        if (!res.ok || !res.body) {
            assistant.finish();
            return;
        }
        const streamResult = await consumeNdjsonStream(res, assistant, runSeq, promptForRetry);
        if (runSeq === state.sessionSwitchSeq) {
            if (streamResult.receivedIdle) {
                shouldReloadFinished = true;
            }
            else if (!streamResult.receivedTerminal) {
                assistant.addInterrupted('Causyne\u2019s response was interrupted.', promptForRetry);
            }
            assistant.finish();
            if (dom.appEl.classList.contains('studio-open')) {
                if (state.studioTab === 'files')
                    void loadFiles(state.currentDir, dom.fileFilterEl.value || '');
                if (state.studioTab === 'diff')
                    void loadDiff();
            }
        }
    }
    catch (err) {
        const isAbort = err instanceof Error && err.name === 'AbortError';
        if (runSeq === state.sessionSwitchSeq && !isAbort) {
            assistant.addInterrupted('Causyne\u2019s response was interrupted.', promptForRetry);
        }
        assistant.finish();
    }
    finally {
        if (state.activeController === controller) {
            state.activeController = null;
            state.activeTurn = null;
            state.activePrompt = '';
            setLiveness(false, '');
            syncPermissionPresetLock(false);
            updateComposerMetrics();
        }
        void loadSessions();
        if (shouldReloadFinished && runSeq === state.sessionSwitchSeq) {
            void loadSessionTranscript(sessionId);
        }
    }
}
export async function submitPrompt(promptText, attachList) {
    const prompt = (promptText || '').trim();
    if (!prompt || state.activeController)
        return;
    const runSeq = state.sessionSwitchSeq;
    appendUserTurn(prompt, attachList, true);
    const assistant = createAssistantTurn(prompt);
    const controller = new AbortController();
    state.activeController = controller;
    state.activeTurn = assistant;
    state.activePrompt = prompt;
    syncPermissionPresetLock(true);
    updateComposerMetrics();
    setLiveness(true, 'Thinking...');
    announceStatus('Causyne is working...');
    try {
        const res = await fetch(apiUrl('/api/chat'), {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
                prompt,
                permissionPreset: state.permissionPreset,
                mode: presetToLegacyMode(state.permissionPreset),
                sessionId: state.sessionId || undefined,
                attachments: attachList
            }),
            signal: controller.signal
        });
        if (runSeq !== state.sessionSwitchSeq)
            return;
        if (!res.ok || !res.body) {
            const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
            assistant.addError(errData.error || 'Request failed.', prompt);
            return;
        }
        const streamResult = await consumeNdjsonStream(res, assistant, runSeq, prompt);
        if (runSeq === state.sessionSwitchSeq) {
            if (!streamResult.receivedTerminal) {
                assistant.addInterrupted('Causyne\u2019s response was interrupted.', prompt);
            }
            assistant.finish();
            announceStatus('Response complete.');
            if (dom.appEl.classList.contains('studio-open')) {
                if (state.studioTab === 'files')
                    void loadFiles(state.currentDir, dom.fileFilterEl.value || '');
                if (state.studioTab === 'diff')
                    void loadDiff();
            }
        }
    }
    catch (err) {
        const isAbort = err instanceof Error && err.name === 'AbortError';
        if (runSeq === state.sessionSwitchSeq && !isAbort) {
            assistant.addInterrupted('Causyne\u2019s response was interrupted.', prompt);
        }
        assistant.finish();
    }
    finally {
        if (state.activeController === controller) {
            state.activeController = null;
            state.activeTurn = null;
            state.activePrompt = '';
            setLiveness(false, '');
            syncPermissionPresetLock(false);
            updateComposerMetrics();
        }
        void loadSessions();
    }
}
