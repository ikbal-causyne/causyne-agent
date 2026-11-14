import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { KeyDecoder } from '../src/tui/keys.js';
import { ApprovalLayer, TextLayer } from '../src/tui/dialogs.js';
import { ChatPrompt } from '../src/tui/prompt.js';
import { StageSurface } from '../src/tui/stageSurface.js';
import { Transcript } from '../src/tui/transcript.js';
import { PromptHistory } from '../src/tui/history.js';
import { CodeStreamRenderer } from '../src/tui/codeStreamRenderer.js';
import { codeProgressFromAction } from '../src/tui/codeProgress.js';
import { stripAnsi } from '../src/tui/text.js';
import { runInteractiveObserverPicker, type ObserverPickerItem } from '../src/tui/observerPicker.js';
import { coldObserver } from '../src/observer/coldObserver.js';
import os from 'node:os';
import path from 'node:path';

function mockIo(columns = 120, rows = 40) {
  const writes: string[] = [];
  const out = {
    columns,
    rows,
    isTTY: true,
    write(chunk: unknown) {
      writes.push(String(chunk ?? ''));
      return true;
    },
    on() {},
    removeListener() {}
  };
  const input = {
    isTTY: true,
    setRawMode() {},
    resume() {},
    pause() {},
    on() {},
    off() {}
  };
  return { out, input, writes };
}

describe('Phase 2 TUI interaction fixes', () => {
  it('handles SGR 0-based mouse clicks in completion picker on an anchored Stage', () => {
    const { out, input } = mockIo(160, 40);
    const surface = new StageSurface({ out, env: {} });
    surface.open();
    const prompt = new ChatPrompt({
      out,
      input,
      surface,
      history: new PromptHistory({ file: path.join(os.tmpdir(), `causyne-p2-hist-${process.pid}.json`) }),
      commands: []
    });
    prompt.active = true;
    prompt.editor.setText('@a');
    prompt.editor.moveEnd();
    prompt.completion = {
      kind: 'file',
      start: 0,
      end: 2,
      items: [
        { value: 'alpha.ts', label: 'alpha.ts' },
        { value: 'beta.ts', label: 'beta.ts' },
        { value: 'gamma.ts', label: 'gamma.ts' }
      ]
    };
    prompt.selected = 0;
    // Stage height 14 at bottom of 40-row screen; prompt occupies bottom 6 rows (y=34..39), picker at y=36..38.
    surface.stage.height = 14;
    prompt.pickerLayout = { pickerStart: 2, pickerCount: 3, totalPromptRows: 6 };

    const decoder = new KeyDecoder();
    // SGR drag motion on item 1 must NOT trigger selection.
    const [drag] = decoder.decode(Buffer.from('\x1b[<32;5;38M'));
    assert.equal(prompt.handleCompletionKey(drag), true);
    assert.equal(prompt.editor.getText(), '@a');

    // Real click at 1-based col 5, row 38 -> 0-based x=4, y=37 -> index 1 ('beta.ts').
    const [click] = decoder.decode(Buffer.from('\x1b[<0;5;38M'));
    assert.equal(prompt.handleCompletionKey(click), true);
    assert.equal(prompt.editor.getText(), '@beta.ts ');
    surface.close();
  });

  it('closes completion picker on sidebar clicks instead of selecting items', () => {
    const { out, input } = mockIo(160, 40);
    const surface = new StageSurface({ out, env: {} });
    surface.open();
    const prompt = new ChatPrompt({
      out,
      input,
      surface,
      history: new PromptHistory({ file: path.join(os.tmpdir(), `causyne-p2-sb-${process.pid}.json`) }),
      commands: []
    });
    prompt.active = true;
    prompt.completion = {
      kind: 'file',
      start: 0,
      end: 2,
      items: [{ value: 'alpha.ts', label: 'alpha.ts' }]
    };
    prompt.pickerLayout = { pickerStart: 2, pickerCount: 1, totalPromptRows: 6 };
    const decoder = new KeyDecoder();
    // Sidebar on 160-col terminal occupies rightmost 34 cols + 1 border (x >= 125).
    const [sidebarClick] = decoder.decode(Buffer.from('\x1b[<0;145;37M'));
    assert.equal(prompt.handleCompletionKey(sidebarClick), true);
    assert.equal(prompt.completion, null);
    surface.close();
  });

  it('handles SGR 0-based mouse clicks on ApprovalLayer chips using drawLayer geometry', () => {
    const { out, input } = mockIo(100, 30);
    const surface = new StageSurface({ out, env: {} });
    surface.open();
    surface.commit('user', () => ['   hello']);
    const prompt = new ChatPrompt({
      out,
      input,
      surface,
      history: new PromptHistory({ file: path.join(os.tmpdir(), `causyne-p2-app-${process.pid}.json`) }),
      commands: []
    });
    prompt.active = true;

    let decision: { approved: boolean; scope: string } | null = null;
    const layer = new ApprovalLayer({
      request: { tool: 'sysRun', risk: 'HIGH', args: { command: 'echo hi' } },
      verb: 'run',
      onAnswer: (approved: boolean, scope: string) => { decision = { approved, scope }; }
    });
    prompt.openLayer(layer);

    assert.ok(layer.panelGeometry);
    assert.equal(layer.panelGeometry.optionScreenRow, 28, 'expected out.rows(30) - status(0) - 2 = 28');
    const onceChip = layer.optionBounds.find((b: { option: { id: string } }) => b.option.id === 'once');
    assert.ok(onceChip);

    const decoder = new KeyDecoder();
    const clickX0 = layer.panelGeometry.inset + 2 + onceChip.startCol + 1;
    const clickY0 = layer.panelGeometry.optionScreenRow;

    // Motion event over button must NOT confirm approval.
    const [drag] = decoder.decode(Buffer.from(`\x1b[<32;${clickX0 + 1};${clickY0 + 1}M`));
    assert.equal(layer.key(drag), 'handled');
    assert.equal(decision, null);

    // Real SGR left click on "Allow once" must approve once and close.
    const [press] = decoder.decode(Buffer.from(`\x1b[<0;${clickX0 + 1};${clickY0 + 1}M`));
    assert.equal(layer.key(press), 'close');
    assert.deepEqual(decision, { approved: true, scope: 'once' });
    surface.close();
  });

  it('closes TextLayer on KeyDecoder enter as well as return/esc/q', () => {
    const decoder = new KeyDecoder();
    const [enterKey] = decoder.decode(Buffer.from('\r'));
    assert.equal(enterKey?.name, 'enter');

    const layer = new TextLayer({ title: 'Help', lines: ['line 1', 'line 2'] });
    assert.equal(layer.key(enterKey), 'close');
  });

  it('settles open confirm/approval modal promises when ChatPrompt.stop() runs', async () => {
    const { out, input } = mockIo(80, 24);
    const prompt = new ChatPrompt({
      out,
      input,
      history: new PromptHistory({ file: path.join(os.tmpdir(), `causyne-p2-stop-${process.pid}.json`) }),
      commands: []
    });
    prompt.start();
    const confirmPromise = prompt.confirm('Delete file?');
    assert.ok(prompt.layer);
    prompt.stop();
    const answer = await confirmPromise;
    assert.equal(answer, false);
    assert.equal(prompt.layer, null);
  });

  it('ignores late healthCheck results in observerPicker after picker is closed', async () => {
    const origHealth = coldObserver.healthCheck.bind(coldObserver);
    let resolveProbe!: (val: { healthy: boolean; endpoint: string; model: string; latencyMs: number; detail: string }) => void;
    coldObserver.healthCheck = () => new Promise((resolve) => { resolveProbe = resolve; });

    let reopened = false;
    let openedLayer: { list: { all: ObserverPickerItem[] }; onPick: (item: ObserverPickerItem | null) => unknown } | null = null;
    const mockPrompt = {
      notice: '',
      openLayer(layer: unknown) {
        if (layer && typeof layer === 'object' && 'lines' in layer) reopened = true;
        else openedLayer = layer as typeof openedLayer;
        return layer;
      },
      closeLayer() {},
      draw() {}
    };

    try {
      const done = runInteractiveObserverPicker(mockPrompt);
      assert.ok(openedLayer);
      const testItem = openedLayer.list.all.find(i => i.id === 'test')!;
      openedLayer.onPick(testItem);
      // Close modal before probe settles.
      openedLayer.onPick(null);
      await done;

      resolveProbe({ healthy: true, endpoint: 'http://localhost:11434/v1', model: 'm', latencyMs: 1, detail: 'ok' });
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(reopened, false);
    } finally {
      coldObserver.healthCheck = origHealth;
    }
  });

  it('centers un-scrolled CodeStreamRenderer panel on diff when draft transitions to Editing', () => {
    const transcript = new Transcript();
    const renderer = new CodeStreamRenderer({ transcript });
    renderer.handle({
      type: 'code_progress',
      id: 'model-draft',
      phase: 'draft',
      operation: 'Creating',
      description: 'Drafting file',
      code: Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n'),
      source: 'model'
    });

    const beforeLines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    const afterLines = [...beforeLines];
    afterLines[3] = 'edited line 4';
    const editEvent = codeProgressFromAction('fs_edit', {
      path: 'app.ts',
      oldText: beforeLines.join('\n'),
      newText: afterLines.join('\n')
    }, 'edit-call');
    assert.ok(editEvent);

    renderer.handle(editEvent);
    const rendered = stripAnsi(transcript.rows(80).join('\n'));
    assert.match(rendered, /\+ edited line 4/, 'diff hunk at top must be shown instead of staying pinned at draft tail');
  });
});
