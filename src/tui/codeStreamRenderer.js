import { ChatRenderer } from './chatRenderer.js';
import { renderCodeProgress } from './codeProgress.js';
/** Adds a live code panel to the existing transcript without changing its other frames. */
export class CodeStreamRenderer extends ChatRenderer {
    activeCode = null;
    modelNote = '';
    lastReasoning = '';
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
        const produce = () => {
            for (const row of renderCodeProgress(event, this.measure(), this.modelNote))
                this.write(row);
        };
        const last = this.transcript?.frames.at(-1);
        const samePanel = last?.meta?.codePreview === true && last.meta.id === event.id;
        if (samePanel)
            this.updateTailFrame('step', produce, { codePreview: true, id: event.id, phase: event.phase });
        else
            this.frame('step', produce, { codePreview: true, id: event.id, phase: event.phase });
    }
}
