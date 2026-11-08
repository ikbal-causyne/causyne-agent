import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { LineEditor } from '../src/tui/lineEditor.js';
import { Stage } from '../src/tui/stage.js';
import { ChatPrompt } from '../src/tui/prompt.js';
import { CodeStreamRenderer } from '../src/tui/codeStreamRenderer.js';

function createSink(columns = 80, rows = 24) {
  const chunks: string[] = [];
  return {
    columns,
    rows,
    isTTY: true,
    write(text: string): boolean {
      chunks.push(text);
      return true;
    },
    on() {},
    removeListener() {},
    text(): string { return chunks.join(''); },
    reset(): void { chunks.length = 0; },
    chunks
  };
}

describe('Chatbox TUI Fixes Verification', () => {
  test('LineEditor: caret sits on wrapped line when positioned at start of wrapped word', () => {
    const editor = new LineEditor('hello world');
    // 'hello ' is 6 chars. 'world' starts at index 6.
    editor.col = 6;
    // width 9: 'hello ' fits on row 0 (used: 6), 'world' wraps to row 1.
    const layout = editor.render(9, '');
    assert.deepEqual(layout.rows, ['hello ', 'world']);
    assert.equal(layout.cursorRow, 1, 'Cursor must be on row 1 before "world"');
    assert.equal(layout.cursorCol, 0, 'Cursor must be at column 0 of row 1');
  });

  test('LineEditor: caret sits on wrapped line when mid-token character wraps past budget', () => {
    const editor = new LineEditor('1234567890abcdef');
    // budget 8: '12345678' fills row 0 (used: 8), '9' is wrapped to row 1.
    editor.col = 8;
    const layout = editor.render(8, '');
    assert.deepEqual(layout.rows, ['12345678', '90abcdef']);
    assert.equal(layout.cursorRow, 1, 'Cursor must be on row 1 before "9"');
    assert.equal(layout.cursorCol, 0, 'Cursor must be at column 0 of row 1');
  });

  test('Stage.paint: does not emit \\x1b[6 q when hideCursor is true', () => {
    const sink = createSink(80, 24);
    const stage = new Stage({ out: sink as any, height: 5 });
    stage.reserve(5);
    sink.reset();

    // 1. Paint with hideCursor = true
    stage.paint(['row 0', 'row 1', 'row 2', 'row 3', 'row 4'], { row: 2, col: 5, hideCursor: true });
    const outputHidden = sink.text();
    assert.ok(!outputHidden.includes('\x1b[6 q'), 'Must NOT emit beam cursor \\x1b[6 q when cursor is hidden');
    assert.ok(outputHidden.includes('\x1b[?25l'), 'Must emit hide cursor \\x1b[?25l');

    // 2. Paint with hideCursor = false
    sink.reset();
    stage.paint(['row 0 changed', 'row 1', 'row 2', 'row 3', 'row 4'], { row: 2, col: 5, hideCursor: false });
    const outputShown = sink.text();
    assert.ok(outputShown.includes('\x1b[6 q'), 'Must emit beam cursor \\x1b[6 q when cursor is shown');
    assert.ok(outputShown.includes('\x1b[?25h'), 'Must emit show cursor \\x1b[?25h');

    stage.collapse();
  });

  test('ChatPrompt: Shift+Enter inserts a newline into the editor instead of submitting', () => {
    const sink = createSink(80, 24);
    const prompt = new ChatPrompt({ out: sink as any });
    prompt.active = true;
    prompt.editor.insert('line 1');

    // User presses Shift+Enter
    prompt.handleKey({ name: 'enter', shift: true, ctrl: false, alt: false });
    assert.equal(prompt.editor.lines.length, 2, 'Shift+Enter must insert a newline');
    assert.equal(prompt.editor.getText(), 'line 1\n', 'Buffer must have newline');
  });

  test('ChatPrompt: queued message is rendered to transcript when read() is called after turn', async () => {
    const sink = createSink(80, 24);
    let renderedUserText = '';
    const mockRenderer = {
      renderUserMessage(text: string): void {
        renderedUserText = text;
      }
    };
    const prompt = new ChatPrompt({ out: sink as any, renderer: mockRenderer as any });
    prompt.active = true;
    prompt.setBusy(true);

    // User types and submits while prompt is busy
    prompt.editor.insert('queued follow-up request');
    prompt.submit();
    assert.equal(renderedUserText, '', 'Must not render immediately while busy');
    assert.equal(prompt.queue.length, 1);

    // Turn ends, prompt becomes unbusy and read() is awaited
    prompt.setBusy(false);
    const nextLine = await prompt.read();
    assert.equal(nextLine, 'queued follow-up request');
    assert.equal(renderedUserText, 'queued follow-up request', 'Must render user message when dequeued');
  });

  test('CodeStreamRenderer: onStatusTick notifies transcript listeners via transcript.changed()', () => {
    const renderer = new CodeStreamRenderer();
    let changeNotified = false;
    const mockTranscript = {
      frames: [
        {
          id: 1,
          meta: { reasoning: true, streaming: true, durationText: '' },
          rows: ['thinking...'],
          renderedWidth: 80
        }
      ],
      cache: {},
      revision: 1,
      changed(): void {
        changeNotified = true;
      }
    };
    (renderer as any).transcript = mockTranscript;

    renderer.onStatusTick(1500, 2);
    assert.ok(changeNotified, 'onStatusTick must notify surface that streaming frame has changed');
    assert.equal(mockTranscript.frames[0]?.meta?.durationText, '1.5s');
    assert.equal(mockTranscript.frames[0]?.rows, null);
    assert.equal(mockTranscript.cache, null);
  });

  test('CodeStreamRenderer: onStatusTick finds active streaming reasoning frame even when other frames are appended after it', () => {
    const renderer = new CodeStreamRenderer();
    let changeNotified = false;
    const mockTranscript = {
      frames: [
        { id: 1, meta: { reasoning: true, streaming: true, durationText: '0.5s' }, rows: ['line 1'], renderedWidth: 80 },
        { id: 2, meta: { notice: true, streaming: false }, rows: ['[plan updated]'], renderedWidth: 80 }
      ],
      cache: {},
      revision: 1,
      changed(): void {
        changeNotified = true;
      }
    };
    (renderer as any).transcript = mockTranscript;

    renderer.onStatusTick(3200, 5);
    assert.ok(changeNotified, 'Must find streaming reasoning frame and notify change even when not at tail');
    assert.equal(mockTranscript.frames[0]?.meta?.durationText, '3.2s');
    assert.equal(mockTranscript.frames[0]?.rows, null);
  });

  test('CodeStreamRenderer: collapseFinishedReasoningFrames preserves frames where user explicitly interacted', () => {
    const renderer = new CodeStreamRenderer();
    let changeNotified = false;
    const mockTranscript = {
      frames: [
        { id: 1, meta: { reasoning: true, streaming: false, collapsed: false, userInteracted: true }, rows: ['thought 1'], renderedWidth: 80 },
        { id: 2, meta: { reasoning: true, streaming: false, collapsed: false, userInteracted: false }, rows: ['thought 2'], renderedWidth: 80 }
      ],
      cache: {},
      revision: 1,
      changed(): void {
        changeNotified = true;
      }
    };
    (renderer as any).transcript = mockTranscript;

    renderer.collapseFinishedReasoningFrames(false);
    assert.ok(changeNotified, 'Must notify change when unexpanded frames are auto-collapsed');
    assert.equal(mockTranscript.frames[0]?.meta?.collapsed, false, 'User-interacted frame must remain expanded');
    assert.equal(mockTranscript.frames[1]?.meta?.collapsed, true, 'Uninteracted frame must be collapsed');
  });

  test('ChatRenderer: onStepError extracts error description from msg.result.error when msg.error is omitted', () => {
    const renderer = new CodeStreamRenderer();
    const emittedLines: string[] = [];
    (renderer as any).write = (line: string) => { if (line) emittedLines.push(line); };

    renderer.onStepError({
      tool: 'browser_act',
      result: { success: false, error: 'Unknown element ref e2. Take a new snapshot before interacting.' }
    });

    const output = emittedLines.join('\n');
    assert.ok(output.includes('browser_act'), 'Must include tool name');
    assert.ok(output.includes('Unknown element ref e2'), 'Must include error message from msg.result.error');
  });
});
