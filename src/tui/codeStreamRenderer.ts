import { ChatRenderer } from './chatRenderer.js';
import { renderCodeProgress, type CodeProgressEvent } from './codeProgress.js';

type RendererEvent = { type: string; [key: string]: unknown };

/** Adds a live code panel to the existing transcript without changing its other frames. */
export class CodeStreamRenderer extends ChatRenderer {
  private activeCode: CodeProgressEvent | null = null;
  private modelNote = '';
  private lastReasoning = '';

  override handle(message: RendererEvent): boolean {
    if (message?.type === 'code_progress') {
      this.onCodeProgress(message as unknown as CodeProgressEvent);
      return true;
    }
    if (message?.type === 'agent_reasoning') {
      const content = typeof message.content === 'string' ? message.content : '';
      if (content) this.lastReasoning = content;
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
      if (message.type === 'task_complete' || message.type === 'error') this.lastReasoning = '';
    }
    return super.handle(message);
  }

  private onCodeProgress(event: CodeProgressEvent): void {
    if (!event || typeof event.id !== 'string' || typeof event.operation !== 'string'
      || typeof event.description !== 'string' || !['draft', 'working', 'done', 'failed'].includes(event.phase)) return;
    if (!this.transcript && event.phase === 'draft') return;
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

  private paintCodePanel(event: CodeProgressEvent): void {
    const produce = (): void => {
      for (const row of renderCodeProgress(event, this.measure(), this.modelNote)) this.write(row);
    };
    const last = this.transcript?.frames.at(-1);
    const samePanel = last?.meta?.codePreview === true && last.meta.id === event.id;
    if (samePanel) this.updateTailFrame('step', produce, { codePreview: true, id: event.id, phase: event.phase });
    else this.frame('step', produce, { codePreview: true, id: event.id, phase: event.phase });
  }
}
