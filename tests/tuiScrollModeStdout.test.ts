import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TextLayer, SelectLayer } from '../src/tui/dialogs.js';
import { SelectList } from '../src/tui/selectList.js';
import { StageSurface } from '../src/tui/stageSurface.js';
import { ChatPrompt } from '../src/tui/prompt.js';
import { PromptHistory } from '../src/tui/history.js';
import { createSession, deleteSession } from '../src/sessionStore.js';
import { runInteractiveSessionPicker } from '../src/tui/sessionPicker.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

describe('Stage consoleGuard terminal-mode isolation', () => {
  it('delivers mouse tracking and bracketed paste sequences on real process.stdout TTY while blocking rogue writes', () => {
    const stageSurfaceUrl = pathToFileURL(path.join(SRC, 'tui', 'stageSurface.js')).href;
    const promptUrl = pathToFileURL(path.join(SRC, 'tui', 'prompt.js')).href;
    const historyUrl = pathToFileURL(path.join(SRC, 'tui', 'history.js')).href;
    const histFile = path.join(os.tmpdir(), `causyne-stdout-mode-hist-${process.pid}-${Date.now()}.json`);

    const script = `
      const writes = [];
      const origWrite = process.stdout.write.bind(process.stdout);
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
      Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
      process.stdout.write = (chunk, enc, cb) => {
        writes.push(
          Buffer.isBuffer(chunk)
            ? chunk.toString('utf8')
            : chunk instanceof Uint8Array
              ? Buffer.from(chunk).toString('utf8')
              : String(chunk ?? '')
        );
        if (typeof enc === 'function') enc();
        else if (typeof cb === 'function') cb();
        return true;
      };

      const { StageSurface } = await import(${JSON.stringify(stageSurfaceUrl)});
      const { ChatPrompt } = await import(${JSON.stringify(promptUrl)});
      const { PromptHistory } = await import(${JSON.stringify(historyUrl)});

      const surface = new StageSurface({ out: process.stdout, env: {} });
      surface.open();
      const afterOpen = writes.splice(0).join('');

      surface.enterHome({ cwd: process.cwd(), provider: 'test' });
      const afterHome = writes.splice(0).join('');

      const fakeIn = { isTTY: true, setRawMode() {}, resume() {}, pause() {}, on() {}, off() {} };
      const prompt = new ChatPrompt({
        input: fakeIn,
        out: process.stdout,
        surface,
        history: new PromptHistory({ file: ${JSON.stringify(histFile)} })
      });
      prompt.start();
      const afterPromptStart = writes.splice(0).join('');

      surface.leaveHome();
      const afterLeave = writes.splice(0).join('');

      // Rogue unmanaged writes must still be blocked while Stage owns process.stdout.
      process.stdout.write('\\n');
      process.stdout.write('\\r');
      process.stdout.write('\\x1b[2J');
      process.stdout.write(new Uint8Array([0x1b, 0x5b, 0x32, 0x4a]));
      console.log('ROGUE_STDOUT_NOISE');
      const rogueAttempt = writes.splice(0).join('');

      surface.releaseMouse();
      const afterRelease = writes.splice(0).join('');

      surface.captureMouse();
      const afterCapture = writes.splice(0).join('');

      surface.suspend();
      const afterSuspend = writes.splice(0).join('');

      surface.resume();
      const afterResume = writes.splice(0).join('');

      prompt.stop();
      const afterStop = writes.splice(0).join('');

      origWrite(JSON.stringify({
        has1000hOpen: afterOpen.includes('\\x1b[?1006h\\x1b[?1000h'),
        has1000lHome: afterHome.includes('\\x1b[?1000l\\x1b[?1006l'),
        has2004hPromptStart: afterPromptStart.includes('\\x1b[?2004h'),
        has1000hLeave: afterLeave.includes('\\x1b[?1006h\\x1b[?1000h'),
        rogueBlocked: rogueAttempt === '',
        has1000lRelease: afterRelease.includes('\\x1b[?1000l\\x1b[?1006l'),
        has1000hCapture: afterCapture.includes('\\x1b[?1006h\\x1b[?1000h'),
        has1000lSuspend: afterSuspend.includes('\\x1b[?1000l\\x1b[?1006l'),
        has1000hResume: afterResume.includes('\\x1b[?1006h\\x1b[?1000h'),
        has1000lStop: afterStop.includes('\\x1b[?1000l\\x1b[?1006l'),
        has2004lStop: afterStop.includes('\\x1b[?2004l')
      }) + '\\n');
    `;

    try {
      const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const result = JSON.parse(stdout.trim()) as Record<string, boolean>;
      assert.deepEqual(result, {
        has1000hOpen: true,
        has1000lHome: true,
        has2004hPromptStart: true,
        has1000hLeave: true,
        rogueBlocked: true,
        has1000lRelease: true,
        has1000hCapture: true,
        has1000lSuspend: true,
        has1000hResume: true,
        has1000lStop: true,
        has2004lStop: true
      });
    } finally {
      fs.rmSync(histFile, { force: true });
    }
  });

  it('TextLayer and SelectList handle wheel scroll events instead of dropping them', () => {
    const textLayer = new TextLayer({
      lines: ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'],
      height: 5
    });
    textLayer.body(40, 3);
    assert.equal(textLayer.scroll, 0);
    assert.equal(textLayer.key({ name: 'wheel', wheel: { direction: 'down', x: 1, y: 1 } }), 'handled');
    assert.equal(textLayer.scroll, 1);
    assert.equal(textLayer.key({ name: 'wheel', wheel: { direction: 'up', x: 1, y: 1 } }), 'handled');
    assert.equal(textLayer.scroll, 0);
    assert.equal(textLayer.key({ name: 'wheel', wheel: { direction: 'up', x: 1, y: 1 } }), 'handled');
    assert.equal(textLayer.scroll, 0);

    const list = new SelectList([{ label: 'a' }, { label: 'b' }, { label: 'c' }]);
    assert.equal(list.selected, 0);
    assert.equal(list.handleKey({ name: 'wheel', wheel: { direction: 'up', x: 0, y: 0 } }, 5), 'handled');
    assert.equal(list.selected, 0, 'wheel up at top clamps instead of wrapping');
    assert.equal(list.handleKey({ name: 'wheel', wheel: { direction: 'down', x: 0, y: 0 } }, 5), 'handled');
    assert.equal(list.selected, 1);
    assert.equal(list.handleKey({ name: 'wheel', wheel: { direction: 'down', x: 0, y: 0 } }, 5), 'handled');
    assert.equal(list.selected, 2);
    assert.equal(list.handleKey({ name: 'wheel', wheel: { direction: 'down', x: 0, y: 0 } }, 5), 'handled');
    assert.equal(list.selected, 2, 'wheel down at bottom clamps instead of wrapping');
  });

  it('SessionPicker transitions surface out of Home and arms mouse reporting cleanly', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-sp-leavehome-'));
    const created = createSession(ws, 'Previous Chat', true);
    const writes: string[] = [];
    const out = {
      columns: 100,
      rows: 35,
      isTTY: true,
      write(chunk: string) { writes.push(chunk); return true; },
      on() {},
      removeListener() {}
    };
    const surface = new StageSurface({ out: out as never, env: {} });
    surface.open();
    surface.enterHome({ cwd: ws, provider: 'test' });
    assert.equal(surface.mouseOn, false);
    writes.length = 0;

    const fakePrompt: {
      surface: StageSurface;
      openLayer: (layer: unknown) => void;
      scheduleDraw: () => void;
    } = {
      surface,
      scheduleDraw() {},
      openLayer(layer: unknown) {
        const selectLayer = layer as {
          list: { filtered: Array<{ item: { value?: { type?: string } } }> };
          onPick: ((item: unknown) => void) | null;
        };
        const match = selectLayer.list.filtered.find((e) => e.item?.value?.type === 'new');
        if (selectLayer.onPick && match) {
          selectLayer.onPick(match.item);
        } else if (selectLayer.onPick) {
          selectLayer.onPick(null);
        }
      }
    };

    try {
      await runInteractiveSessionPicker(fakePrompt, { workspace: ws });
      assert.equal(surface.homeInfo, null, 'switching/starting session must exit Home view');
      assert.equal(surface.mouseOn, true, 'exiting Home via session picker must enable mouse reporting');
      assert.ok(writes.join('').includes('\x1b[?1006h\x1b[?1000h'));
    } finally {
      surface.close();
      try { deleteSession(created.id); } catch {}
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
