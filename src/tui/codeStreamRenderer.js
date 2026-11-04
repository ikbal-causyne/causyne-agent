import { ChatRenderer } from './chatRenderer.js';
import { CODE_PANEL_LINES, codePreviewLineCount, defaultPreviewStart, renderCodeProgress } from './codeProgress.js';
import { calculateThinkingLineCount, DEFAULT_MAX_EXPANDED_LINES } from './thinkingBox.js';
import { markerAt } from './messageInteraction.js';
function lastStart(event) {
    return Math.max(0, codePreviewLineCount(event) - CODE_PANEL_LINES);
}
/** Adds a live code panel to the existing transcript without changing its other frames. */
export class CodeStreamRenderer extends ChatRenderer {
    activeCode = null;
    modelNote = '';
    lastReasoning = '';
    currentActivity = 'thinking';
    codePanels = new WeakMap();
    /** Scroll only the code beneath the pointer; leave the chat viewport alone. */
    scrollCodePanel(key, surface) {
        const wheel = key?.wheel;
        if (key?.name !== 'wheel' || !wheel || !surface || !['up', 'down'].includes(wheel.direction))
            return false;
        const transcript = (this.transcript || surface.transcript);
        if (!transcript)
            return false;
        if (!surface.transcript)
            surface.transcript = transcript;
        const marker = markerAt(surface, { x: wheel.x, y: wheel.y });
        if (!marker)
            return false;
        const frame = transcript.frames.find(item => item.id === marker.id);
        const state = frame && this.codePanels.get(frame);
        if (!frame || !state)
            return false;
        const limit = lastStart(state.event);
        if (limit === 0)
            return false;
        const next = Math.max(0, Math.min(limit, state.start + (wheel.direction === 'up' ? -3 : 3)));
        if (next === state.start)
            return true;
        state.start = next;
        state.followTail = next === limit;
        frame.rows = null;
        frame.renderedWidth = -1;
        transcript.cache = null;
        transcript.revision++;
        transcript.changed();
        return true;
    }
    /** Scroll only the thinking panel beneath the pointer; leave the chat viewport alone. */
    scrollThinkingPanel(key, surface) {
        const wheel = key?.wheel;
        if (key?.name !== 'wheel' || !wheel || !surface || !['up', 'down'].includes(wheel.direction))
            return false;
        const transcript = (this.transcript || surface.transcript);
        if (!transcript)
            return false;
        if (!surface.transcript)
            surface.transcript = transcript;
        const marker = markerAt(surface, { x: wheel.x, y: wheel.y });
        if (!marker || marker.kind !== 'reasoning')
            return false;
        const frame = transcript.frames.find(item => item.id === marker.id);
        if (!frame || frame.meta?.reasoning !== true || frame.meta?.collapsed)
            return false;
        const content = typeof frame.meta.content === 'string' ? frame.meta.content : '';
        const totalLines = calculateThinkingLineCount(content, this.measure());
        const limit = Math.max(0, totalLines - DEFAULT_MAX_EXPANDED_LINES);
        if (limit === 0)
            return false;
        const currentStart = Number(frame.meta.scrollStart) || 0;
        const next = Math.max(0, Math.min(limit, currentStart + (wheel.direction === 'up' ? -3 : 3)));
        if (next === currentStart)
            return true;
        frame.meta.scrollStart = next;
        frame.rows = null;
        frame.renderedWidth = -1;
        transcript.cache = null;
        transcript.revision++;
        transcript.changed();
        return true;
    }
    resetTurn() {
        this._activeReasoning = false;
        this.activeCode = null;
        this.modelNote = '';
        this.lastReasoning = '';
        this.collapseFinishedReasoningFrames(true);
        super.resetTurn();
    }
    turnFooter(durationMs) {
        this.collapseFinishedReasoningFrames(true);
        super.turnFooter(durationMs);
    }
    /**
     * Auto-collapses completed thinking box frames when a session turn finishes,
     * keeping the conversation viewport clean while preserving interactive click-to-expand.
     */
    collapseFinishedReasoningFrames(forceAll = false) {
        const transcript = this.transcript;
        if (!transcript || !Array.isArray(transcript.frames))
            return;
        let changed = false;
        for (const frame of transcript.frames) {
            if (frame?.meta?.reasoning === true && (forceAll || frame.meta.userInteracted !== true) && frame.meta.collapsed !== true) {
                frame.meta.collapsed = true;
                frame.meta.streaming = false;
                frame.rows = null;
                frame.renderedWidth = -1;
                changed = true;
            }
        }
        if (changed) {
            transcript.cache = null;
            transcript.revision++;
            transcript.changed();
        }
    }
    handle(message) {
        if (message?.type === 'agent_activity') {
            const rawActivity = String(message.activity || message.message || '').trim();
            if (rawActivity) {
                this.currentActivity = rawActivity.replace(/…|\.\.\.$/, '').trim();
                if (this._activeReasoning && this.lastReasoning) {
                    super.onAgentReasoning({
                        content: this.lastReasoning,
                        streaming: true,
                        activity: this.currentActivity,
                        title: rawActivity
                    });
                    return true;
                }
            }
        }
        if (message?.type === 'notice' && message.nativeStep === true) {
            this.stepCount = (this.stepCount || 0) + 1;
            const stepLine = String(message.message || '').trim();
            if (stepLine) {
                const actionName = String(message.actionName || stepLine).toLowerCase();
                let activity = this.currentActivity || 'processing';
                if (['read_file', 'fs_read', 'view_file', 'cat', 'grep', 'find', 'ls'].some(k => actionName.includes(k))) {
                    activity = 'analyzing';
                }
                else if (['run_command', 'sysrun', 'bash', 'terminal', 'sh', 'exec'].some(k => actionName.includes(k))) {
                    activity = 'executing';
                }
                else if (['write_file', 'edit_file', 'multiedit', 'replace_file_content', 'fs_write'].some(k => actionName.includes(k))) {
                    activity = 'editing';
                }
                else if (['web_search', 'web_fetch', 'browse'].some(k => actionName.includes(k))) {
                    activity = 'researching';
                }
                else if (['plan', 'todo'].some(k => actionName.includes(k))) {
                    activity = 'planning';
                }
                this.currentActivity = activity;
                const currentContent = this.lastReasoning ? `${this.lastReasoning}\n${stepLine}` : stepLine;
                this.lastReasoning = currentContent;
                super.onAgentReasoning({
                    content: currentContent,
                    streaming: true,
                    activity,
                    title: `${activity}…`
                });
                return true;
            }
        }
        if (message?.type === 'code_progress') {
            this.onCodeProgress(message);
            return true;
        }
        if (message?.type === 'agent_reasoning') {
            const content = typeof message.content === 'string' ? message.content : '';
            if (content)
                this.lastReasoning = content;
            const transcript = this.transcript;
            const tailIsReasoning = transcript?.frames.at(-1)?.meta?.reasoning === true;
            if (this._activeReasoning && transcript && !tailIsReasoning) {
                this._activeReasoning = false;
            }
            if (this.activeCode && this.transcript) {
                const note = content.trim().split('\n').at(-1) || '';
                this.modelNote = note.slice(-140);
                this.paintCodePanel(this.activeCode);
                if (message.streaming === false) {
                    this.lastReasoning = '';
                }
                return true;
            }
            const handled = super.handle({
                ...message,
                activity: message.activity || this.currentActivity
            });
            if (message.streaming === false) {
                this.lastReasoning = '';
            }
            return handled;
        }
        if (['agent_message', 'budget_warning', 'step_start', 'task_complete', 'error', 'agent_plan'].includes(message?.type || '')
            || (message?.type === 'notice' && !message.nativeStep)) {
            if (this._activeReasoning && this.lastReasoning) {
                super.onAgentReasoning({
                    content: this.lastReasoning,
                    streaming: false,
                    activity: this.currentActivity
                });
            }
            this._activeReasoning = false;
            this.lastReasoning = '';
            if (message?.type === 'task_complete' || (message?.type === 'agent_message' && message.streaming !== true)) {
                this.collapseFinishedReasoningFrames(true);
            }
            if (['step_start', 'task_complete', 'error'].includes(message?.type || '')
                || (message?.type === 'agent_message' && message.streaming !== true)) {
                this.activeCode = null;
                this.modelNote = '';
            }
        }
        return super.handle(message);
    }
    onCodeProgress(event) {
        if (!event || typeof event.id !== 'string' || typeof event.operation !== 'string'
            || typeof event.description !== 'string' || !['draft', 'working', 'done', 'failed'].includes(event.phase))
            return;
        if (!this.transcript && event.phase === 'draft')
            return;
        if (this.lastReasoning && !this.modelNote) {
            this.modelNote = (this.lastReasoning.trim().split('\n').at(-1) || '').slice(-140);
        }
        if (this._activeReasoning) {
            super.onAgentReasoning({ content: this.lastReasoning, streaming: false });
        }
        this.lastReasoning = '';
        this.activeCode = event;
        this.paintCodePanel(event);
        if (event.phase === 'done' || event.phase === 'failed') {
            this.activeCode = null;
            this.modelNote = '';
        }
    }
    paintCodePanel(event) {
        const transcript = this.transcript;
        const frames = transcript?.frames || [];
        const last = frames.at(-1);
        const sameTail = last?.meta?.codePreview === true && (last.meta.id === event.id || last.meta.id === 'model-draft');
        // Look back for an existing code panel frame for this operation (e.g. model-draft or same id)
        let targetFrame;
        if (sameTail && last) {
            targetFrame = last;
        }
        else {
            for (let i = frames.length - 1; i >= Math.max(0, frames.length - 6); i--) {
                const f = frames[i];
                if (f?.meta?.codePreview === true && (f.meta.id === event.id || (f.meta.id === 'model-draft' && event.id !== 'model-draft'))) {
                    targetFrame = f;
                    break;
                }
            }
        }
        const state = targetFrame ? this.codePanels.get(targetFrame) : undefined;
        const panelState = state || {
            event,
            modelNote: this.modelNote,
            start: defaultPreviewStart(event),
            followTail: event.operation !== 'Editing'
        };
        panelState.event = event;
        panelState.modelNote = this.modelNote;
        panelState.start = panelState.followTail ? lastStart(event) : Math.min(panelState.start, lastStart(event));
        const produce = () => {
            for (const row of renderCodeProgress(panelState.event, this.measure(), panelState.modelNote, panelState.start))
                this.write(row);
        };
        if (targetFrame && targetFrame === last) {
            this.updateTailFrame('step', produce, { codePreview: true, id: event.id, phase: event.phase });
            this.codePanels.set(last, panelState);
        }
        else if (targetFrame && transcript) {
            targetFrame.produce = (width) => this.capture(width, produce);
            targetFrame.meta = { ...(targetFrame.meta || {}), codePreview: true, id: event.id, phase: event.phase };
            targetFrame.rows = null;
            targetFrame.renderedWidth = -1;
            transcript.cache = null;
            transcript.revision++;
            transcript.changed();
            this.codePanels.set(targetFrame, panelState);
        }
        else {
            this.frame('step', produce, { codePreview: true, id: event.id, phase: event.phase });
            const current = transcript?.frames.at(-1);
            if (current)
                this.codePanels.set(current, panelState);
        }
    }
}
