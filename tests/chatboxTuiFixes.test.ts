import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { LineEditor } from '../src/tui/lineEditor.js';
import { Stage } from '../src/tui/stage.js';
import { StageSurface } from '../src/tui/stageSurface.js';
import { ChatPrompt } from '../src/tui/prompt.js';
import { CodeStreamRenderer } from '../src/tui/codeStreamRenderer.js';
import { visibleWidth, stripAnsi } from '../src/tui/text.js';

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

  test('ChatPrompt.planRows: compacts plan to 1 line on cramped terminals (stageMax < 22) to protect chatbox vertical budget', () => {
    const sink = createSink(80, 18);
    const mockRenderer = {
      latestPlan: [
        { text: 'Step 1: Check requirements', status: 'completed' },
        { text: 'Step 2: Implement tactile micro-vibration feedback', status: 'in_progress' },
        { text: 'Step 3: Run unit tests', status: 'pending' },
        { text: 'Step 4: Build artifact', status: 'pending' },
        { text: 'Step 5: Sign deliverable', status: 'pending' }
      ]
    };
    const prompt = new ChatPrompt({ out: sink as any, renderer: mockRenderer as any });
    const rows = prompt.planRows(80);
    // On 18-row terminal (stageMax < 22), planRows should return compact 2-line structure (1 text line + 1 blank line)
    assert.equal(rows.length, 2, 'Must collapse 5-step plan to compact 2-line summary on cramped terminal');
    assert.ok(rows[0]?.includes('plan'), 'Must include plan label');
    assert.ok(rows[0]?.includes('1/5'), 'Must include completed count (1/5)');
    assert.ok(rows[0]?.includes('tactile micro-vibration'), 'Must include active in-progress step');
  });

  test('ChatPrompt.drawLayer: budgets dialogHeight reserving room for status bar so dialog panels never exceed stage boundary', () => {
    const sink = createSink(80, 16);
    const prompt = new ChatPrompt({ out: sink as any });
    prompt.active = true;

    // Simulate an approval dialog requesting 20 lines on a 16-row terminal
    const mockLayer = {
      width: 60,
      preferredHeight: () => 20,
      cursor: null,
      panelGeometry: null,
      body: () => [
        '┌── permission required ──┐',
        '│ Allow dangerous tool?  │',
        '│ Option 1: Allow once   │',
        '│ Option 2: Reject       │',
        '└─── esc to cancel ───────┘'
      ]
    };
    prompt.layer = mockLayer as any;

    let presentedRows: string[] = [];
    prompt.present = (all: string[]) => { presentedRows = all; };
    prompt.drawLayer(80);

    // Dialog + status must not exceed terminal ceiling (16 rows)
    assert.ok(presentedRows.length <= 16, `Presented rows (${presentedRows.length}) must fit within 16-row terminal`);
    assert.ok(presentedRows.some(r => r.includes('permission required')), 'Must contain dialog header without being severed');
  });

  test('visibleWidth accounts for wide Miscellaneous Symbols and Dingbats (⚡, ✅, ❌, ✨, ⏳) so Stage rows never overflow terminal width', () => {
    assert.equal(visibleWidth('⚡'), 2);
    assert.equal(visibleWidth('✅'), 2);
    assert.equal(visibleWidth('❌'), 2);
    assert.equal(visibleWidth('✨'), 2);
    assert.equal(visibleWidth('⏳'), 2);
    assert.equal(visibleWidth('⚡ android/android-debugging-and-testing'), 40);
  });

  test('Stage.paint wraps row output in DECAWM reset/set (\\x1b[?7l ... \\x1b[?7h) to prevent hardware line-wrap drift', () => {
    const sink = createSink(80, 24);
    const stage = new Stage({ out: sink as any, height: 4 });
    stage.reserve(4);
    sink.reset();

    stage.paint(['row 0', 'row 1', 'row 2', 'row 3'], { row: 1, col: 2 });
    const out = sink.text();
    const wrapOffIdx = out.indexOf('\x1b[?7l');
    const wrapOnIdx = out.indexOf('\x1b[?7h');
    assert.ok(wrapOffIdx !== -1, 'Must emit DECAWM reset \\x1b[?7l before writing stage rows');
    assert.ok(wrapOnIdx > wrapOffIdx, 'Must restore DECAWM \\x1b[?7h after writing stage rows');
    stage.collapse();
  });

  test('StageSurface.attachRail truncates ANSI-prefixed rows when prepending turn-rail cells so rows never exceed contentWidth + 2', () => {
    const sink = createSink(153, 40);
    const surface = new StageSurface({ out: sink as any, env: { TERM: 'xterm-256color' } });
    surface.open();
    surface.commit('user', () => ['  › Build release bundle']);
    surface.commit('error', () => [
      '  \x1b[41m\x1b[37m ERROR \x1b[0m ACP Peer Agent (opencode) Error: AI_APICallError: Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go'
    ]);
    surface.commit('turn', () => [
      '  \x1b[32m▪\x1b[0m deepseek-v4.1-flash-f…  ·  235 steps  ·  40m 9s',
      '\x1b[2m  /usage for cost  ·  /undo to roll back\x1b[0m'
    ]);

    const contentWidth = 109;
    const rows = [
      '  \x1b[41m\x1b[37m ERROR \x1b[0m ' + 'X'.repeat(contentWidth),
      '\x1b[2m  /usage for cost  ·  /undo to roll back\x1b[0m'
    ];
    const attached = surface.attachRail(rows, contentWidth);
    for (const r of attached) {
      assert.equal(visibleWidth(r), contentWidth + 2, 'Every rail-attached row must be exactly contentWidth + 2 columns');
    }
    surface.close();
  });

  test('StageSurface + ChatPrompt preserve all 5 chatbox rows and caret row across mid-loop approval/question dialogs and error + turnFooter', async () => {
    const sink = createSink(153, 40);
    const surface = new StageSurface({ out: sink as any, env: { TERM: 'xterm-256color' } });
    surface.open();
    surface.setSessionInfo({
      title: '/workspace/downloads/ConnectLife',
      cwd: '/workspace',
      provider: 'acp/opencode',
      model: 'deepseek-v4.1-flash-free',
      activeSkill: {
        name: 'android/android-debugging-and-testing',
        description: 'Diagnose, debug, install, and verify Android applications'
      }
    });

    const renderer = new CodeStreamRenderer({ transcript: surface.transcript });
    renderer.status.setSession({
      provider: 'acp/opencode',
      model: 'deepseek-v4.1-flash-free'
    });
    const prompt = new ChatPrompt({
      out: sink as any,
      getMode: () => 'C'
    });
    prompt.attachSurface(surface as any);
    prompt.attach(renderer as any);
    prompt.active = true;

    // 1. Start a busy turn
    renderer.renderUserMessage('Build and verify APK');
    prompt.setBusy(true);

    // 2. Trigger mid-loop approval dialog (allow / always allow / deny) and resolve it
    const approvalPromise = prompt.approve({
      tool: 'sys_run',
      risk: 'MEDIUM',
      reason: 'Run ./gradlew assembleRelease',
      args: { command: './gradlew assembleRelease' }
    });
    assert.ok(prompt.layer, 'Approval layer must be active');
    prompt.handleKey({ name: 'enter', shift: false, ctrl: false, alt: false });
    const approved = await approvalPromise;
    assert.ok(approved && typeof approved === 'object', 'Approval promise must resolve');

    // 3. Trigger mid-loop ask_question decision dialog and resolve it
    const decisionPromise = prompt.decide({
      question: 'Which build variant should be signed?',
      header: 'Build Variant',
      options: [
        { label: 'release', description: 'Production signed bundle' },
        { label: 'debug', description: 'Local debug APK' }
      ]
    });
    assert.ok(prompt.layer, 'Decision layer must be active');
    prompt.handleKey({ name: 'enter', shift: false, ctrl: false, alt: false });
    const decision = await decisionPromise;
    assert.ok(decision && !(decision as any).cancelled, 'Decision promise must resolve without cancellation');

    // 4. Emit mid-loop error + turnFooter + setBusy(false) (the exact sequence from cliMode.js)
    renderer.onError({
      message: 'ACP Peer Agent (opencode) Error: AI_APICallError: Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go'
    });
    renderer.turnFooter(2409000);
    prompt.setBusy(false);

    // Wait for any scheduled setImmediate draw to settle
    await new Promise(resolve => setImmediate(resolve));

    const prev = surface.stage.prev.map((r: string) => stripAnsi(r));
    const placeholderIdx = prev.findIndex((r: string) => r.includes(`try "${prompt.example}"`));
    const buildIdx = prev.findIndex((r: string) => r.includes('Build C'));
    assert.ok(placeholderIdx !== -1, 'Top placeholder row ("try \\"explain...\\"") must remain intact in stage');
    assert.ok(buildIdx !== -1, 'Bottom controls row ("Build C") must remain intact in stage');
    assert.equal(buildIdx - placeholderIdx, 2, 'Chatbox must have intact separator row between placeholder and Build C');
    assert.equal(surface.stage.cursor, placeholderIdx, 'Terminal cursor must rest on the input/placeholder row, never on Build C');

    surface.close();
  });

  test('100-iteration stress test: StageSurface + ChatPrompt never clip chatbox rows across 100 approval/decision/error/turnFooter sequences', async () => {
    for (let iter = 1; iter <= 100; iter++) {
      const cols = 100 + (iter % 80); // 100..179 columns (tests both sidebar-hidden and sidebar-visible layouts)
      const rows = 28 + (iter % 45);  // 28..72 rows
      const sink = createSink(cols, rows);
      const surface = new StageSurface({ out: sink as any, env: { TERM: 'xterm-256color' } });
      surface.open();
      surface.setSessionInfo({
        title: `/workspace/Project_${iter}`,
        cwd: '/workspace',
        provider: iter % 2 === 0 ? 'acp/opencode' : 'antigravity',
        model: iter % 2 === 0 ? 'deepseek-v4.1-flash-free' : 'Gemini 3.8 Flash (High)',
        activeSkill: {
          name: 'android/android-debugging-and-testing',
          description: 'Diagnose, debug, install, and verify Android applications'
        }
      });

      const renderer = new CodeStreamRenderer({ transcript: surface.transcript });
      renderer.status.setSession({
        provider: iter % 2 === 0 ? 'acp/opencode' : 'antigravity',
        model: iter % 2 === 0 ? 'deepseek-v4.1-flash-free' : 'Gemini 3.8 Flash (High)'
      });
      const prompt = new ChatPrompt({
        out: sink as any,
        getMode: () => 'C'
      });
      prompt.attachSurface(surface as any);
      prompt.attach(renderer as any);
      prompt.active = true;

      renderer.renderUserMessage(`Iteration ${iter}: build and verify project`);
      prompt.setBusy(true);

      // Approval layer mid-loop
      const approvalPromise = prompt.approve({
        tool: 'sys_run',
        risk: 'MEDIUM',
        reason: `Execute step ${iter}`,
        args: { command: `./gradlew assembleRelease --iter=${iter}` }
      });
      prompt.handleKey({ name: iter % 3 === 0 ? 'escape' : 'enter', shift: false, ctrl: false, alt: false });
      await approvalPromise;

      // Decision layer mid-loop on even iterations
      if (iter % 2 === 0) {
        const decisionPromise = prompt.decide({
          question: `Select target for iteration ${iter}?`,
          header: 'Target',
          options: [
            { label: 'production', description: 'Production bundle' },
            { label: 'staging', description: 'Staging APK' }
          ]
        });
        prompt.handleKey({ name: 'enter', shift: false, ctrl: false, alt: false });
        await decisionPromise;
      }

      // Error or step_error mid-loop
      if (iter % 3 === 0) {
        renderer.onStepError({
          tool: 'sys_run',
          result: { success: false, error: `Command failed on iteration ${iter}` }
        });
      } else {
        renderer.onError({
          message: `ACP Peer Agent (opencode) Error: AI_APICallError: Free usage limit reached on iteration ${iter}.`
        });
      }

      renderer.turnFooter(1000 * iter);
      prompt.setBusy(false);

      await new Promise(resolve => setImmediate(resolve));

      // Verify width invariant on every painted stage row
      for (const rawRow of surface.stage.prev) {
        assert.ok(
          visibleWidth(rawRow) <= cols - 1,
          `Iteration ${iter}: stage row width (${visibleWidth(rawRow)}) exceeded cols - 1 (${cols - 1})`
        );
      }

      const prev = surface.stage.prev.map((r: string) => stripAnsi(r));
      const placeholderIdx = prev.findIndex((r: string) => r.includes(`try "${prompt.example}"`) || r.includes('ask anything'));
      const buildIdx = prev.findIndex((r: string) => r.includes('Build C'));
      assert.ok(placeholderIdx >= 1, `Iteration ${iter}: placeholder row must exist with padTop row above it`);
      assert.ok(buildIdx !== -1, `Iteration ${iter}: Build C row must exist`);
      assert.equal(buildIdx - placeholderIdx, 2, `Iteration ${iter}: chatbox rows must not be clipped`);
      assert.equal(surface.stage.cursor, placeholderIdx, `Iteration ${iter}: cursor must sit on placeholder row`);

      surface.close();
    }
  });
});
