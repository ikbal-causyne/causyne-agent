import { ChatRenderer } from './chatRenderer.js';
import { CODE_PANEL_LINES, renderCodeProgress } from './codeProgress.js';
function lastStart(event) {
    return Math.max(0, String(event.code || '').split(/\r?\n/).length - CODE_PANEL_LINES);
}
/** Adds a live code panel to the existing transcript without changing its other frames. */
export class CodeStreamRenderer extends ChatRenderer {
    activeCode = null;
    modelNote = '';
    lastReasoning = '';
    codePanels = new WeakMap();
    /** Scroll only the code beneath the pointer; leave the chat viewport alone. */
    scrollCodePanel(key, surface) {
        const wheel = key.wheel;
        if (key.name !== 'wheel' || !wheel || !surface || !['up', 'down'].includes(wheel.direction))
            return false;
        const transcript = this.transcript;
        if (!transcript || !Number.isFinite(surface.out.rows) || !Number.isFinite(wheel.x) || !Number.isFinite(wheel.y))
            return false;
        const viewport = surface.viewport;
        const screenTop = surface.out.rows - surface.stage.height;
        const localY = wheel.y - screenTop;
        if (localY < 0 || localY >= viewport.viewHeight || wheel.x < 0 || wheel.x >= Math.min(viewport.viewWidth, this.measure()))
            return false;
        const { markers } = transcript.flatten(viewport.viewWidth);
        const absoluteY = viewport.scrollTop + localY;
        const markerIndex = markers.findIndex((marker, index) => marker.row <= absoluteY
            && (index + 1 === markers.length || absoluteY < markers[index + 1].row));
        if (markerIndex < 0)
            return false;
        const marker = markers[markerIndex];
        const frame = transcript.frames.find(item => item.id === marker.id);
        const state = frame && this.codePanels.get(frame);
        if (!frame || !state || absoluteY >= marker.row + (frame.rows?.length || 0))
            return false;
        const limit = lastStart(state.event);
        if (limit === 0)
            return false;
        const next = Math.max(0, Math.min(limit, state.start + (wheel.direction === 'up' ? -3 : 3)));
        if (next === state.start)
            return false;
        state.start = next;
        state.followTail = next === limit;
        frame.rows = null;
        frame.renderedWidth = -1;
        transcript.cache = null;
        transcript.revision++;
        transcript.changed();
        return true;
    }
    handle(message) {
        if (message?.type === 'code_progress') {
            this.onCodeProgress(message);
            return true;
        }
        if (message?.type === 'agent_reasoning') {
            const content = typeof message.content === 'string' ? message.content : '';
            if (content)
                this.lastReasoning = content;
            if (this.activeCode && this.transcript) {
                const note = content.trim().split('\n').at(-1) || '';
                this.modelNote = note.slice(-140);
                this.paintCodePanel(this.activeCode);
                return true;
            }
        }
        if (['agent_message', 'step_start', 'task_complete', 'error'].includes(message?.type || '')) {
            this.activeCode = null;
            this.modelNote = '';
            if (message.type === 'task_complete' || message.type === 'error')
                this.lastReasoning = '';
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
        const last = transcript?.frames.at(-1);
        const samePanel = last?.meta?.codePreview === true && last.meta.id === event.id;
        const state = samePanel && last ? this.codePanels.get(last) : undefined;
        const panelState = state || { event, modelNote: this.modelNote, start: lastStart(event), followTail: true };
        panelState.event = event;
        panelState.modelNote = this.modelNote;
        panelState.start = panelState.followTail ? lastStart(event) : Math.min(panelState.start, lastStart(event));
        const produce = () => {
            for (const row of renderCodeProgress(panelState.event, this.measure(), panelState.modelNote, panelState.start))
                this.write(row);
        };
        if (samePanel)
            this.updateTailFrame('step', produce, { codePreview: true, id: event.id, phase: event.phase });
        else
            this.frame('step', produce, { codePreview: true, id: event.id, phase: event.phase });
        const current = transcript?.frames.at(-1);
        if (current)
            this.codePanels.set(current, panelState);
    }
}
