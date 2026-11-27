import { announceAlert, cloneCausyneMark, copyText, dom } from './dom.js';
import { apiUrl, authHeaders, scrollToBottom, setLiveness, setStageMode, state, updateComposerMetrics } from './state.js';
import { artifactBadgeFor, extractLoopbackUrls, isHtmlOrSvgPath } from './validators.js';
import { renderMarkdownInto } from './markdown.js';
import { createStreamSmoother } from './streamSmoother.js';
let callbacks = {
    openFile: async () => { },
    openInCanvas: () => { },
    openBrowserUrl: () => { },
    openBrowserArtifact: () => { },
    openSettingsForUpgrade: () => { },
    submitPrompt: async () => { }
};
export function configureTurnViewCallbacks(cbs) {
    callbacks = cbs;
}
function createBrandAvatar() {
    const wrap = document.createElement('div');
    wrap.className = 'assistant-avatar';
    const mark = cloneCausyneMark('');
    if (mark)
        wrap.appendChild(mark);
    return wrap;
}
function summarizeToolTarget(args) {
    if (!args || typeof args !== 'object')
        return '';
    const raw = args.path || args.filePath || args.file || args.command || args.query || args.url || '';
    return typeof raw === 'string' ? raw.slice(0, 90) : '';
}
function formatThoughtDuration(ms) {
    const secs = Math.round(ms / 1000);
    if (secs < 1)
        return 'Thought briefly';
    if (secs < 60)
        return `Thought for ${secs}s`;
    const mins = Math.floor(secs / 60);
    const rem = secs % 60;
    return rem > 0 ? `Thought for ${mins}m ${rem}s` : `Thought for ${mins}m`;
}
function classifyStepKind(toolName) {
    const t = String(toolName || '').toLowerCase();
    if (t === 'fs_read' || t === 'read_file' || t === 'view_file' || t === 'view_image')
        return 'read';
    if (t === 'fs_write' || t === 'write_file' || t === 'create_file' || t === 'write_to_file')
        return 'write';
    if (t === 'fs_edit' || t === 'edit_file' || t === 'multi_edit' || t === 'apply_patch')
        return 'edit';
    if (t === 'fs_list' || t === 'fs_search' || t === 'grep' || t === 'glob')
        return 'search';
    if (t === 'sysrun' || t === 'bash' || t === 'shell' || t === 'run_command')
        return 'cmd';
    if (t.includes('browser') || t === 'screenshot')
        return 'browser';
    if (t.includes('web_search') || t.includes('web_fetch'))
        return 'web';
    if (t === 'tool_search')
        return 'discover';
    if (t === 'update_plan')
        return 'plan';
    return 'other';
}
export function summarizeTimelineSteps(stepKinds, totalCount, isRunning, elapsedMs, restored) {
    if (totalCount === 0)
        return isRunning ? 'Working...' : 'Completed';
    const counts = new Map();
    for (const k of stepKinds)
        counts.set(k, (counts.get(k) || 0) + 1);
    const parts = [];
    const add = (key, sg, pl) => {
        const n = counts.get(key) || 0;
        if (n > 0)
            parts.push(n === 1 ? sg : pl.replace('{n}', String(n)));
    };
    add('read', 'Read a file', 'Read {n} files');
    add('write', 'Created a file', 'Created {n} files');
    add('edit', 'Edited a file', 'Edited {n} files');
    add('search', 'Searched files', 'Searched files');
    add('cmd', 'Ran a command', 'Ran {n} commands');
    add('browser', 'Used browser', 'Used browser ({n})');
    add('web', 'Searched the web', 'Searched the web');
    const prefix = parts.length > 0
        ? parts.slice(0, 3).join(', ')
        : (isRunning
            ? `Working · ${totalCount}${totalCount === 1 ? ' step' : ' steps'}`
            : `${totalCount}${totalCount === 1 ? ' step' : ' steps'}`);
    if (isRunning)
        return `${prefix}...`;
    if (!restored && typeof elapsedMs === 'number' && elapsedMs >= 1000) {
        return `${prefix} · ${Math.round(elapsedMs / 1000)}s`;
    }
    return prefix;
}
export function createCollapsibleCard(initialLabel, openByDefault, dotKind) {
    const root = document.createElement('div');
    root.className = `collapsible-card${openByDefault ? ' is-open' : ''}`;
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'collapsible-trigger';
    trigger.setAttribute('aria-expanded', openByDefault ? 'true' : 'false');
    const left = document.createElement('span');
    left.className = 'collapsible-trigger-left';
    const dot = document.createElement('span');
    dot.className = `status-dot${dotKind ? ` ${dotKind}` : ''}`;
    const labelEl = document.createElement('span');
    labelEl.className = 'collapsible-label';
    labelEl.textContent = initialLabel;
    left.appendChild(dot);
    left.appendChild(labelEl);
    const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chev.setAttribute('viewBox', '0 0 24 24');
    chev.setAttribute('class', 'collapsible-chevron');
    const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    pl.setAttribute('points', '9 6 15 12 9 18');
    chev.appendChild(pl);
    trigger.appendChild(left);
    trigger.appendChild(chev);
    const body = document.createElement('div');
    body.className = 'collapsible-body';
    const inner = document.createElement('div');
    inner.className = 'collapsible-inner';
    body.appendChild(inner);
    root.appendChild(trigger);
    root.appendChild(body);
    let userToggled = false;
    const setOpen = (next, byUser) => {
        if (byUser)
            userToggled = true;
        root.classList.toggle('is-open', Boolean(next));
        trigger.setAttribute('aria-expanded', next ? 'true' : 'false');
    };
    trigger.addEventListener('click', () => setOpen(!root.classList.contains('is-open'), true));
    return {
        root,
        inner,
        labelEl,
        dot,
        setOpen,
        wasUserToggled: () => userToggled,
        setActive(active) { root.classList.toggle('is-active', Boolean(active)); }
    };
}
let threadSpacerEl = null;
let lastLiveUserTurnEl = null;
function ensureThreadSpacer() {
    if (!threadSpacerEl || !threadSpacerEl.isConnected) {
        threadSpacerEl = document.createElement('div');
        threadSpacerEl.id = 'thread-spacer';
        threadSpacerEl.className = 'thread-spacer';
        threadSpacerEl.setAttribute('aria-hidden', 'true');
        threadSpacerEl.style.height = '0px';
        dom.threadEl.appendChild(threadSpacerEl);
    }
    else if (dom.threadEl.lastElementChild !== threadSpacerEl) {
        dom.threadEl.appendChild(threadSpacerEl);
    }
    return threadSpacerEl;
}
export function resetThreadSpacer() {
    lastLiveUserTurnEl = null;
    if (threadSpacerEl)
        threadSpacerEl.style.height = '0px';
}
function updateThreadSpacer() {
    if (!threadSpacerEl || !lastLiveUserTurnEl || !lastLiveUserTurnEl.isConnected || !dom.threadWrapEl)
        return;
    const userRect = lastLiveUserTurnEl.getBoundingClientRect();
    const spacerRect = threadSpacerEl.getBoundingClientRect();
    const contentBelowUser = Math.max(0, spacerRect.top - userRect.top);
    const targetExtra = Math.max(0, dom.threadWrapEl.clientHeight - contentBelowUser - 36);
    threadSpacerEl.style.height = `${Math.round(targetExtra)}px`;
}
export function appendUserTurn(prompt, attachments, animate = false) {
    setStageMode(true);
    const turn = document.createElement('div');
    turn.className = `turn user${animate ? ' turn-enter' : ''}`;
    if (attachments && attachments.length > 0) {
        const line = document.createElement('div');
        line.className = 'attach-line';
        for (const p of attachments) {
            const tag = document.createElement('span');
            tag.className = 'attach-tag';
            tag.textContent = `@${p}`;
            line.appendChild(tag);
        }
        turn.appendChild(line);
    }
    const bubble = document.createElement('div');
    bubble.className = 'user-bubble';
    bubble.textContent = prompt;
    turn.appendChild(bubble);
    const uActs = document.createElement('div');
    uActs.className = 'user-actions';
    const cp = document.createElement('button');
    cp.type = 'button';
    cp.className = 'msg-action-btn';
    cp.textContent = 'Copy';
    cp.addEventListener('click', () => copyText(prompt, cp));
    const ed = document.createElement('button');
    ed.type = 'button';
    ed.className = 'msg-action-btn';
    ed.textContent = 'Edit';
    ed.addEventListener('click', () => {
        dom.promptInput.value = prompt;
        updateComposerMetrics();
        dom.promptInput.focus();
    });
    uActs.appendChild(cp);
    uActs.appendChild(ed);
    turn.appendChild(uActs);
    if (threadSpacerEl && threadSpacerEl.parentElement === dom.threadEl) {
        dom.threadEl.insertBefore(turn, threadSpacerEl);
    }
    else {
        dom.threadEl.appendChild(turn);
    }
    if (animate) {
        lastLiveUserTurnEl = turn;
        ensureThreadSpacer();
        updateThreadSpacer();
        window.requestAnimationFrame(() => {
            updateThreadSpacer();
            scrollToBottom(true, true);
        });
    }
    else {
        scrollToBottom(true);
    }
}
export function createAssistantTurn(promptForRetry, opts) {
    const isRestored = Boolean(opts?.restored);
    setStageMode(true);
    const turn = document.createElement('div');
    turn.className = `turn assistant${isRestored ? '' : ' turn-enter'}`;
    const row = document.createElement('div');
    row.className = `assistant-row${isRestored ? '' : ' is-streaming'}`;
    row.appendChild(createBrandAvatar());
    const col = document.createElement('div');
    col.className = 'assistant-col';
    const eventsSlot = document.createElement('div');
    eventsSlot.style.display = 'flex';
    eventsSlot.style.flexDirection = 'column';
    eventsSlot.style.gap = '8px';
    const artifactsSlot = document.createElement('div');
    artifactsSlot.style.display = 'flex';
    artifactsSlot.style.flexDirection = 'column';
    artifactsSlot.style.gap = '8px';
    const prose = document.createElement('div');
    prose.className = 'assistant-prose';
    const urlPreviewSlot = document.createElement('div');
    urlPreviewSlot.className = 'preview-url-bar';
    const errorSlot = document.createElement('div');
    errorSlot.style.display = 'flex';
    errorSlot.style.flexDirection = 'column';
    errorSlot.style.gap = '8px';
    const liveRow = document.createElement('div');
    liveRow.className = `turn-live-row${isRestored ? '' : ' is-active'}`;
    const liveMark = document.createElement('span');
    liveMark.className = 'turn-live-mark';
    const liveSvg = cloneCausyneMark('');
    if (liveSvg)
        liveMark.appendChild(liveSvg);
    const liveLabel = document.createElement('span');
    liveLabel.className = 'turn-live-label';
    liveLabel.textContent = 'Thinking...';
    liveRow.appendChild(liveMark);
    liveRow.appendChild(liveLabel);
    const actionsRow = document.createElement('div');
    actionsRow.className = 'msg-actions';
    actionsRow.style.display = 'none';
    col.appendChild(eventsSlot);
    col.appendChild(artifactsSlot);
    col.appendChild(prose);
    col.appendChild(urlPreviewSlot);
    col.appendChild(errorSlot);
    col.appendChild(liveRow);
    col.appendChild(actionsRow);
    row.appendChild(col);
    turn.appendChild(row);
    if (threadSpacerEl && threadSpacerEl.parentElement === dom.threadEl) {
        dom.threadEl.insertBefore(turn, threadSpacerEl);
    }
    else {
        dom.threadEl.appendChild(turn);
    }
    let rawText = '';
    let reasoningText = '';
    let interruptedShown = false;
    let reasonCard = null;
    let reasonBody = null;
    let reasonStartedAt = 0;
    let reasonCollapsedOnProse = false;
    let planCard = null;
    let timelineCard = null;
    let timelineStepsEl = null;
    let timelineStartedAt = 0;
    let stepCount = 0;
    let runningSteps = 0;
    const stepKinds = [];
    const toolCards = new Map();
    const codeCards = new Map();
    function renderText(textToRender, isStreaming) {
        renderMarkdownInto(prose, textToRender, isStreaming);
        if (isStreaming && prose.lastElementChild) {
            prose.lastElementChild.classList.add('stream-fade');
        }
        updateThreadSpacer();
        scrollToBottom(false);
    }
    const proseSmoother = createStreamSmoother((visibleText, isStreaming) => {
        renderText(visibleText, isStreaming);
    });
    const reasonSmoother = createStreamSmoother((visibleReasoning, isStreaming) => {
        if (!reasonBody)
            return;
        reasonBody.textContent = visibleReasoning;
        reasonBody.scrollTop = reasonBody.scrollHeight;
        if (reasonCard && isStreaming) {
            const sec = Math.max(1, Math.round((Date.now() - reasonStartedAt) / 1000));
            reasonCard.labelEl.textContent = `Thinking · ${sec}s`;
        }
        scrollToBottom(false);
    });
    function ensureTimeline() {
        if (timelineCard)
            return;
        timelineStartedAt = Date.now();
        const card = createCollapsibleCard('Working...', !isRestored, isRestored ? 'done' : 'running');
        if (!isRestored)
            card.setActive(true);
        const stepsWrap = document.createElement('div');
        stepsWrap.className = 'timeline-steps';
        card.inner.appendChild(stepsWrap);
        eventsSlot.appendChild(card.root);
        timelineCard = card;
        timelineStepsEl = stepsWrap;
    }
    function refreshTimelineHeader(done) {
        if (!timelineCard)
            return;
        const running = !done && runningSteps > 0;
        const elapsed = Date.now() - timelineStartedAt;
        timelineCard.labelEl.textContent = summarizeTimelineSteps(stepKinds, stepCount, running, elapsed, isRestored);
        timelineCard.setActive(running);
        timelineCard.dot.className = `status-dot ${running ? 'running' : 'done'}`;
    }
    function collapseThinkingOnProse() {
        if (!reasonCard || reasonCollapsedOnProse || isRestored)
            return;
        reasonCollapsedOnProse = true;
        reasonSmoother.flush();
        reasonCard.setActive(false);
        reasonCard.dot.className = 'status-dot done';
        reasonCard.labelEl.textContent = formatThoughtDuration(Date.now() - reasonStartedAt);
        if (!reasonCard.wasUserToggled())
            reasonCard.setOpen(false, false);
    }
    function syncLoopbackButtons() {
        urlPreviewSlot.textContent = '';
        for (const u of extractLoopbackUrls(rawText)) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'preview-url-btn';
            btn.textContent = `Open ${u} in Live Browser`;
            btn.addEventListener('click', () => callbacks.openBrowserUrl(u));
            urlPreviewSlot.appendChild(btn);
        }
    }
    function buildStepRow(toolName, targetText, statusText, failed, outputText) {
        const card = document.createElement('div');
        card.className = 'tool-card';
        const head = document.createElement('div');
        head.className = 'tool-card-head';
        const hLeft = document.createElement('span');
        hLeft.className = 'tool-head-left';
        const sDot = document.createElement('span');
        sDot.className = `status-dot ${statusText === 'running...' ? 'running' : failed ? 'failed' : 'done'}`;
        const name = document.createElement('span');
        name.className = 'tool-badge';
        name.textContent = toolName;
        const target = document.createElement('span');
        target.className = 'tool-target';
        target.textContent = targetText;
        hLeft.appendChild(sDot);
        hLeft.appendChild(name);
        hLeft.appendChild(target);
        const st = document.createElement('span');
        st.className = 'tool-state';
        st.textContent = statusText;
        if (failed)
            st.style.color = 'var(--err)';
        head.appendChild(hLeft);
        head.appendChild(st);
        card.appendChild(head);
        if (outputText) {
            const out = document.createElement('div');
            out.className = 'tool-out';
            out.textContent = String(outputText).slice(0, 480);
            card.appendChild(out);
        }
        return { card, statusEl: st, dotEl: sDot };
    }
    return {
        setActivity(active, label) {
            if (isRestored)
                return;
            liveRow.classList.toggle('is-active', Boolean(active));
            if (label)
                liveLabel.textContent = label;
        },
        appendText(delta) {
            collapseThinkingOnProse();
            rawText += delta;
            proseSmoother.push(delta);
        },
        setText(full, streaming) {
            if (full)
                collapseThinkingOnProse();
            rawText = full;
            proseSmoother.setFull(full, Boolean(streaming));
        },
        updateReasoning(ev) {
            if (!reasonCard) {
                reasonStartedAt = Date.now();
                const openInit = Boolean(ev.streaming && !isRestored);
                reasonCard = createCollapsibleCard(isRestored ? 'Thought process' : 'Thinking...', openInit, ev.streaming ? 'thinking' : 'done');
                reasonCard.setActive(Boolean(ev.streaming && !isRestored));
                reasonBody = document.createElement('div');
                reasonBody.className = 'reason-body';
                reasonCard.inner.appendChild(reasonBody);
                eventsSlot.prepend(reasonCard.root);
            }
            if (typeof ev.content === 'string' && ev.content.length >= reasoningText.length) {
                reasoningText = ev.content;
                reasonSmoother.setFull(reasoningText, Boolean(ev.streaming && !isRestored));
            }
            else if (typeof ev.delta === 'string') {
                reasoningText += ev.delta;
                reasonSmoother.push(ev.delta);
            }
            if (isRestored) {
                reasonCard.labelEl.textContent = 'Thought process';
                reasonCard.setActive(false);
                reasonCard.dot.className = 'status-dot done';
            }
            else if (!ev.streaming) {
                const ms = typeof ev.elapsedMs === 'number' ? ev.elapsedMs : (Date.now() - reasonStartedAt);
                reasonCard.labelEl.textContent = formatThoughtDuration(ms);
                reasonCard.setActive(false);
                reasonCard.dot.className = 'status-dot done';
            }
            scrollToBottom(false);
        },
        renderRestoredBlocks(blocks) {
            const allTextParts = [];
            prose.style.display = 'none';
            for (const blk of blocks) {
                if (blk.kind === 'reasoning' && blk.content) {
                    const rc = createCollapsibleCard('Thought process', false, 'done');
                    const rb = document.createElement('div');
                    rb.className = 'reason-body';
                    rb.textContent = blk.content;
                    rc.inner.appendChild(rb);
                    eventsSlot.appendChild(rc.root);
                }
                else if (blk.kind === 'steps' && Array.isArray(blk.steps) && blk.steps.length > 0) {
                    const kinds = blk.steps.map((s) => classifyStepKind(s.tool));
                    const label = summarizeTimelineSteps(kinds, blk.steps.length, false, 0, true);
                    const tc = createCollapsibleCard(label, false, blk.steps.some((s) => s.status === 'failed') ? 'failed' : 'done');
                    const sw = document.createElement('div');
                    sw.className = 'timeline-steps';
                    for (const st of blk.steps) {
                        const rowObj = buildStepRow(st.tool || 'step', st.target || '', st.status === 'failed' ? 'failed' : 'done', st.status === 'failed', st.output || '');
                        sw.appendChild(rowObj.card);
                    }
                    tc.inner.appendChild(sw);
                    eventsSlot.appendChild(tc.root);
                }
                else if (blk.kind === 'text' && blk.content) {
                    allTextParts.push(blk.content);
                    const seg = document.createElement('div');
                    seg.className = 'assistant-prose';
                    renderMarkdownInto(seg, blk.content, false);
                    eventsSlot.appendChild(seg);
                }
            }
            rawText = allTextParts.join('\n\n');
        },
        updatePlan(ev) {
            const items = Array.isArray(ev.plan) ? ev.plan : [];
            if (items.length === 0)
                return;
            if (!planCard) {
                planCard = document.createElement('div');
                planCard.className = 'plan-card';
                eventsSlot.appendChild(planCard);
            }
            planCard.textContent = '';
            const doneCount = items.filter((s) => s.status === 'completed').length;
            const head = document.createElement('div');
            head.className = 'plan-head';
            const left = document.createElement('span');
            left.textContent = ev.explanation || 'Execution Plan';
            const right = document.createElement('span');
            right.textContent = `${doneCount}/${items.length}`;
            head.appendChild(left);
            head.appendChild(right);
            planCard.appendChild(head);
            for (const s of items) {
                const line = document.createElement('div');
                const st = String(s.status || 'pending');
                line.className = `plan-step${st === 'completed' ? ' done' : st === 'in_progress' ? ' active' : ''}`;
                const ic = document.createElement('span');
                ic.className = 'step-icon';
                ic.textContent = st === 'completed' ? '✓' : st === 'in_progress' ? '●' : '○';
                const txt = document.createElement('span');
                txt.textContent = s.text || s.step || '';
                line.appendChild(ic);
                line.appendChild(txt);
                planCard.appendChild(line);
            }
            scrollToBottom(false);
        },
        addStepStart(ev) {
            ensureTimeline();
            stepCount += 1;
            runningSteps += 1;
            stepKinds.push(classifyStepKind(ev.tool));
            const targetStr = summarizeToolTarget(ev.args);
            const built = buildStepRow(ev.tool || 'tool', targetStr, 'running...', false, '');
            timelineStepsEl?.appendChild(built.card);
            const key = ev.toolCallId || (`${ev.tool || 'tool'}:${stepCount}`);
            toolCards.set(key, { card: built.card, status: built.statusEl, dot: built.dotEl, startedAt: Date.now() });
            refreshTimelineHeader(false);
            setLiveness(true, (ev.tool || 'Running') + (targetStr ? ` · ${targetStr}` : ''));
            scrollToBottom(false);
        },
        addStepEnd(ev, failed) {
            ensureTimeline();
            if (runningSteps > 0)
                runningSteps -= 1;
            const key = ev.toolCallId || '';
            const entry = key ? toolCards.get(key) : null;
            const resObj = ev.result && typeof ev.result === 'object' ? ev.result : null;
            const rawOut = ev.error || ev.summary || (typeof ev.output === 'string' ? ev.output : '')
                || (resObj && typeof resObj.output === 'string' ? resObj.output : '')
                || (resObj && typeof resObj.message === 'string' ? resObj.message : '');
            if (!entry) {
                stepCount += 1;
                stepKinds.push(classifyStepKind(ev.tool));
                const built = buildStepRow(ev.tool || 'tool', '', failed ? 'failed' : 'done', failed, rawOut);
                timelineStepsEl?.appendChild(built.card);
            }
            else {
                const elapsed = Math.max(1, Date.now() - entry.startedAt);
                entry.status.textContent = `${failed ? 'failed · ' : 'done · '}${elapsed}ms`;
                entry.dot.className = `status-dot ${failed ? 'failed' : 'done'}`;
                if (failed)
                    entry.status.style.color = 'var(--err)';
                if (rawOut) {
                    const out = document.createElement('div');
                    out.className = 'tool-out';
                    out.textContent = String(rawOut).slice(0, 480);
                    entry.card.appendChild(out);
                }
            }
            refreshTimelineHeader(false);
            scrollToBottom(false);
        },
        addNativeStep(ev, failed) {
            const actionName = String(ev.actionName || '').trim();
            const detail = String(ev.detail || '').trim();
            const msg = String(ev.message || '').trim();
            if (actionName === 'true' || actionName === ':' || detail === 'true' || detail === ':')
                return;
            if (!actionName && (!msg || /(?:^|\s)(?:true|:)$/.test(msg)))
                return;
            ensureTimeline();
            stepCount += 1;
            const cleanAction = actionName.replace(/^causyne[-_]browser[_:]/i, '');
            stepKinds.push(classifyStepKind(cleanAction));
            const cleanMsg = msg.replace(/^acp\/[a-z0-9._-]+\s+/i, '').replace(/^causyne[-_]browser[_:]/i, '');
            const built = buildStepRow(cleanAction || 'step', detail || (cleanMsg && cleanMsg !== cleanAction ? cleanMsg : ''), failed ? 'failed' : 'done', failed, '');
            timelineStepsEl?.appendChild(built.card);
            refreshTimelineHeader(false);
            scrollToBottom(false);
        },
        upsertCodeProgress(ev) {
            const key = ev.id || ev.path || (`code-${codeCards.size}`);
            let slot = codeCards.get(key);
            if (!slot) {
                const card = document.createElement('div');
                card.className = 'artifact-card streaming';
                const top = document.createElement('div');
                top.className = 'artifact-top';
                const meta = document.createElement('div');
                meta.className = 'artifact-meta';
                const ic = document.createElement('div');
                ic.className = 'artifact-icon';
                const textBox = document.createElement('div');
                textBox.style.minWidth = '0';
                const title = document.createElement('div');
                title.className = 'artifact-title';
                const sub = document.createElement('div');
                sub.className = 'artifact-sub';
                textBox.appendChild(title);
                textBox.appendChild(sub);
                meta.appendChild(ic);
                meta.appendChild(textBox);
                const btns = document.createElement('div');
                btns.className = 'artifact-btns';
                top.appendChild(meta);
                top.appendChild(btns);
                const pre = document.createElement('pre');
                pre.className = 'artifact-stream-pre';
                card.appendChild(top);
                card.appendChild(pre);
                artifactsSlot.appendChild(card);
                slot = { card, ic, title, sub, btns, pre, code: '', path: '' };
                codeCards.set(key, slot);
            }
            const relPath = ev.path || slot.path || 'workspace-file';
            slot.path = relPath;
            if (typeof ev.code === 'string')
                slot.code = ev.code;
            const badge = artifactBadgeFor(relPath, '');
            slot.ic.textContent = badge.tag;
            slot.title.textContent = relPath;
            const lines = slot.code ? slot.code.split('\n').length : 0;
            const phase = ev.phase || 'working';
            slot.card.classList.toggle('streaming', phase === 'draft' || phase === 'working');
            slot.sub.textContent = `${ev.operation || 'Updating'} · ${badge.label}${lines > 0 ? ` · ${lines} lines` : ''} · ${phase}`;
            if (slot.code) {
                slot.pre.style.display = 'block';
                slot.pre.textContent = slot.code.split('\n').slice(-10).join('\n');
            }
            else {
                slot.pre.style.display = 'none';
            }
            slot.btns.textContent = '';
            if (phase === 'done') {
                slot.pre.style.display = 'none';
                const openBtn = document.createElement('button');
                openBtn.type = 'button';
                openBtn.className = 'btn-ghost';
                openBtn.textContent = 'Open';
                const capturedCode = slot.code;
                openBtn.addEventListener('click', () => {
                    if (capturedCode)
                        callbacks.openInCanvas(relPath, capturedCode, relPath.endsWith('.md') || isHtmlOrSvgPath(relPath));
                    else
                        void callbacks.openFile(relPath);
                });
                slot.btns.appendChild(openBtn);
                if (isHtmlOrSvgPath(relPath) && capturedCode) {
                    const liveBtn = document.createElement('button');
                    liveBtn.type = 'button';
                    liveBtn.className = 'btn-primary';
                    liveBtn.textContent = 'Preview';
                    liveBtn.addEventListener('click', () => callbacks.openBrowserArtifact(relPath, capturedCode));
                    slot.btns.appendChild(liveBtn);
                }
            }
            scrollToBottom(false);
        },
        addApproval(ev) {
            const box = document.createElement('div');
            box.className = 'approval-card';
            const top = document.createElement('div');
            top.className = 'approval-top';
            const text = document.createElement('span');
            text.className = 'approval-text';
            text.textContent = `Allow ${ev.tool || 'tool'}?`;
            const btns = document.createElement('div');
            btns.className = 'approval-actions';
            const yes = document.createElement('button');
            yes.type = 'button';
            yes.className = 'btn-primary';
            yes.textContent = 'Allow';
            const always = document.createElement('button');
            always.type = 'button';
            always.className = 'btn-ghost';
            always.textContent = 'Always allow';
            const no = document.createElement('button');
            no.type = 'button';
            no.className = 'btn-danger';
            no.textContent = 'Deny';
            const decide = async (approved, remember) => {
                yes.disabled = true;
                always.disabled = true;
                no.disabled = true;
                await fetch(apiUrl('/api/approve'), {
                    method: 'POST',
                    headers: authHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({
                        sessionId: state.sessionId || undefined,
                        toolCallId: ev.toolCallId,
                        approved,
                        remember: Boolean(remember),
                        tool: ev.tool || ''
                    })
                });
                text.textContent = (approved ? (remember ? 'Always allowed ' : 'Allowed ') : 'Denied ') + (ev.tool || 'tool');
                btns.textContent = '';
                const badge = document.createElement('span');
                badge.className = 'pop-sub';
                badge.textContent = approved ? (remember ? 'Always allowed' : 'Allowed') : 'Denied';
                if (!approved)
                    badge.style.color = 'var(--err)';
                btns.appendChild(badge);
            };
            yes.addEventListener('click', () => { void decide(true, false); });
            always.addEventListener('click', () => { void decide(true, true); });
            no.addEventListener('click', () => { void decide(false, false); });
            btns.appendChild(yes);
            btns.appendChild(always);
            btns.appendChild(no);
            top.appendChild(text);
            top.appendChild(btns);
            box.appendChild(top);
            if (ev.args && typeof ev.args === 'object' && Object.keys(ev.args).length > 0) {
                const pre = document.createElement('pre');
                pre.className = 'approval-args';
                try {
                    pre.textContent = JSON.stringify(ev.args, null, 2).slice(0, 600);
                }
                catch { /* ignore */ }
                box.appendChild(pre);
            }
            eventsSlot.appendChild(box);
            setLiveness(true, `Waiting for approval · ${ev.tool || 'tool'}`);
            scrollToBottom(true);
        },
        addDecision(reqObj) {
            if (!reqObj || typeof reqObj !== 'object')
                return;
            const box = document.createElement('div');
            box.className = 'decision-card';
            const q = document.createElement('div');
            q.className = 'decision-q';
            q.textContent = reqObj.question || 'Choose how to proceed:';
            box.appendChild(q);
            const optsWrap = document.createElement('div');
            optsWrap.className = 'decision-options';
            const optButtons = [];
            let resolved = false;
            const customInput = document.createElement('input');
            const customBtn = document.createElement('button');
            const submitChoice = async (optionId, label, custom) => {
                if (resolved || !label)
                    return;
                resolved = true;
                for (const b of optButtons)
                    b.disabled = true;
                customInput.disabled = true;
                customBtn.disabled = true;
                await fetch(apiUrl('/api/decision'), {
                    method: 'POST',
                    headers: authHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({
                        sessionId: state.sessionId || undefined,
                        requestId: reqObj.id || '',
                        optionId: optionId || null,
                        label,
                        custom: Boolean(custom)
                    })
                }).catch(() => { });
                optsWrap.textContent = '';
                const chosen = document.createElement('span');
                chosen.className = 'pop-sub';
                chosen.textContent = `Selected: ${label}`;
                optsWrap.appendChild(chosen);
            };
            const options = Array.isArray(reqObj.options) ? reqObj.options : [];
            for (const opt of options) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'decision-opt-btn';
                const lbl = document.createElement('span');
                lbl.className = 'decision-opt-label';
                lbl.textContent = opt.label || opt.id || 'Option';
                btn.appendChild(lbl);
                if (opt.description) {
                    const desc = document.createElement('span');
                    desc.className = 'decision-opt-desc';
                    desc.textContent = opt.description;
                    btn.appendChild(desc);
                }
                btn.addEventListener('click', () => {
                    void submitChoice(opt.id || null, opt.label || opt.id || '', false);
                });
                optButtons.push(btn);
                optsWrap.appendChild(btn);
            }
            const customRow = document.createElement('div');
            customRow.className = 'decision-custom-row';
            customInput.type = 'text';
            customInput.className = 'decision-custom-input';
            customInput.placeholder = 'Or type a custom answer...';
            customBtn.type = 'button';
            customBtn.className = 'btn-ghost';
            customBtn.textContent = 'Send';
            customBtn.addEventListener('click', () => { void submitChoice(null, (customInput.value || '').trim(), true); });
            customInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    void submitChoice(null, (customInput.value || '').trim(), true);
                }
            });
            customRow.appendChild(customInput);
            customRow.appendChild(customBtn);
            box.appendChild(optsWrap);
            box.appendChild(customRow);
            eventsSlot.appendChild(box);
            setLiveness(true, 'Waiting for your decision...');
            updateThreadSpacer();
            scrollToBottom(true);
        },
        addNotice(msg) {
            const card = document.createElement('div');
            card.className = 'tool-card';
            card.textContent = msg;
            eventsSlot.appendChild(card);
            updateThreadSpacer();
            scrollToBottom(false);
        },
        addError(msg, retryText, code) {
            const err = document.createElement('div');
            err.className = code === 'DAILY_LIMIT_REACHED' ? 'msg-upgrade' : 'msg-error';
            const txt = document.createElement('span');
            txt.textContent = msg;
            err.appendChild(txt);
            if (code === 'DAILY_LIMIT_REACHED') {
                const acts = document.createElement('div');
                acts.className = 'msg-upgrade-actions';
                const upgBtn = document.createElement('button');
                upgBtn.type = 'button';
                upgBtn.className = 'btn-primary';
                upgBtn.textContent = 'Upgrade to Pro';
                upgBtn.addEventListener('click', () => callbacks.openSettingsForUpgrade());
                acts.appendChild(upgBtn);
                err.appendChild(acts);
            }
            else {
                const targetRetry = retryText || promptForRetry;
                if (targetRetry) {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'btn-ghost';
                    btn.textContent = 'Retry';
                    btn.addEventListener('click', () => {
                        err.remove();
                        void callbacks.submitPrompt(targetRetry, []);
                    });
                    err.appendChild(btn);
                }
            }
            errorSlot.appendChild(err);
            announceAlert(msg);
            updateThreadSpacer();
            scrollToBottom(true);
        },
        addInterrupted(msg, retryText) {
            if (interruptedShown)
                return;
            interruptedShown = true;
            const box = document.createElement('div');
            box.className = 'msg-interrupted';
            const txt = document.createElement('span');
            txt.textContent = msg || 'Causyne\u2019s response was interrupted.';
            box.appendChild(txt);
            const targetRetry = retryText || promptForRetry;
            if (targetRetry) {
                const acts = document.createElement('div');
                acts.className = 'msg-interrupted-actions';
                const contBtn = document.createElement('button');
                contBtn.type = 'button';
                contBtn.className = 'btn-primary';
                contBtn.textContent = 'Continue';
                contBtn.addEventListener('click', () => {
                    box.remove();
                    void callbacks.submitPrompt(targetRetry, []);
                });
                acts.appendChild(contBtn);
                box.appendChild(acts);
            }
            errorSlot.appendChild(box);
            updateThreadSpacer();
            scrollToBottom(false);
        },
        finish() {
            row.classList.remove('is-streaming');
            liveRow.classList.remove('is-active');
            reasonSmoother.flush();
            if (prose.style.display !== 'none')
                proseSmoother.flush();
            if (reasonCard && !isRestored) {
                reasonCard.setActive(false);
                reasonCard.dot.className = 'status-dot done';
                reasonCard.labelEl.textContent = formatThoughtDuration(Date.now() - reasonStartedAt);
                if (!reasonCard.wasUserToggled())
                    reasonCard.setOpen(false, false);
            }
            syncLoopbackButtons();
            refreshTimelineHeader(true);
            if (timelineCard && stepCount > 0 && !timelineCard.wasUserToggled())
                timelineCard.setOpen(false, false);
            if (!rawText.trim())
                return;
            actionsRow.textContent = '';
            actionsRow.style.display = 'flex';
            const copyBtn = document.createElement('button');
            copyBtn.type = 'button';
            copyBtn.className = 'msg-action-btn';
            copyBtn.textContent = 'Copy';
            copyBtn.addEventListener('click', () => copyText(rawText, copyBtn));
            const canvasBtn = document.createElement('button');
            canvasBtn.type = 'button';
            canvasBtn.className = 'msg-action-btn';
            canvasBtn.textContent = 'Open in Canvas';
            canvasBtn.addEventListener('click', () => callbacks.openInCanvas('response.idoc.md', rawText, true));
            actionsRow.appendChild(copyBtn);
            actionsRow.appendChild(canvasBtn);
            if (promptForRetry) {
                const retryBtn = document.createElement('button');
                retryBtn.type = 'button';
                retryBtn.className = 'msg-action-btn';
                retryBtn.textContent = 'Regenerate';
                retryBtn.addEventListener('click', () => { void callbacks.submitPrompt(promptForRetry, []); });
                actionsRow.appendChild(retryBtn);
            }
        }
    };
}
