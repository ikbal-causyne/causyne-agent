// TUI Mouse & Viewport Scroll Isolation Tests
// Verifies OpenCode behavior parity:
// 1. Overscrolling past top/bottom saturates inside the chat box and never releases mouse tracking.
// 2. The terminal scrollback is isolated and never hijacked.
// 3. Causyne never detaches or freezes during wheel or scrollbar interactions.
// 4. Rail clicks safely clamp even if clicked preceding or following the chat box.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { StageSurface } from '../src/tui/stageSurface.js';
import { ChatPrompt } from '../src/tui/prompt.js';
import { PromptHistory } from '../src/tui/history.js';
import { handleViewportWheel, handleScrollbarMouse } from '../src/tui/scrollInteraction.js';

function sink({ columns = 100, rows = 40, isTTY = true }: { columns?: number; rows?: number; isTTY?: boolean } = {}) {
  const chunks: string[] = [];
  return {
    columns,
    rows,
    isTTY,
    write(text: string) { chunks.push(text); return true; },
    on() {},
    removeListener() {},
    text: () => chunks.join(''),
    reset: () => { chunks.length = 0; },
    chunks
  };
}

function fakeInput() {
  return { isTTY: true, setRawMode() {}, resume() {}, pause() {}, on() {}, off() {} };
}

function createTestHarness({ rows = 30, columns = 90, frameCount = 100 } = {}) {
  const out = sink({ rows, columns });
  const surface = new StageSurface({ out: out as any, env: {} });
  surface.open();
  const file = path.join(os.tmpdir(), `causyne-scroll-${process.pid}-${Math.random()}`);
  const prompt = new ChatPrompt({
    input: fakeInput() as any,
    out: out as any,
    surface,
    history: new PromptHistory({ file })
  });
  prompt.attachSurface(surface);
  prompt.active = true;

  for (let i = 0; i < frameCount; i++) {
    surface.transcript.append({ kind: 'notice', produce: () => [`message frame ${i}`] });
  }
  prompt.draw();
  return { prompt, surface, out };
}

describe('TUI Scroll Isolation & OpenCode Parity', () => {
  test('overscroll up past top boundary saturates cleanly and never releases mouse', () => {
    const { prompt, surface } = createTestHarness();
    const viewport = surface.viewport;
    assert.ok(viewport, 'viewport must exist');

    // Scroll to top
    viewport.toTop();
    assert.equal(viewport.scrollTop, 0);
    assert.equal(surface.mouseCaptured, true);
    assert.equal(surface.detached, false);

    let releaseMouseCalled = false;
    const originalReleaseMouse = surface.releaseMouse.bind(surface);
    surface.releaseMouse = () => {
      releaseMouseCalled = true;
      return originalReleaseMouse();
    };

    // Repeated wheel up events past top boundary
    for (let i = 0; i < 20; i++) {
      prompt.handleKey({ name: 'wheel', wheel: { direction: 'up', x: 10, y: 5 } });
    }

    // Must saturate at 0 and NEVER release mouse
    assert.equal(viewport.scrollTop, 0);
    assert.equal(releaseMouseCalled, false, 'releaseMouse must NEVER be called on upward overscroll');
    assert.equal(surface.mouseCaptured, true, 'mouse reporting must remain captured');
    assert.equal(surface.detached, false, 'surface must never be marked detached');
    assert.ok(!prompt.notice.startsWith('top of this view'), 'must not set detached notice');
  });

  test('downward wheel immediately moves down from top boundary without freezing', () => {
    const { prompt, surface } = createTestHarness();
    const viewport = surface.viewport;

    // Start at top
    viewport.toTop();
    assert.equal(viewport.scrollTop, 0);

    // One notch down
    prompt.handleKey({ name: 'wheel', wheel: { direction: 'down', x: 10, y: 5 } });
    assert.ok(viewport.scrollTop > 0, 'downward wheel must immediately move scroll position down');
    assert.equal(surface.detached, false, 'surface must stay attached');
  });

  test('overscroll down past bottom boundary saturates at maxScrollTop and follows', () => {
    const { prompt, surface } = createTestHarness();
    const viewport = surface.viewport;

    // Start at bottom
    viewport.toBottom();
    const max = viewport.maxScrollTop();
    assert.equal(viewport.scrollTop, max);
    assert.equal(viewport.following, true);

    // Repeated downward wheel past bottom
    for (let i = 0; i < 20; i++) {
      prompt.handleKey({ name: 'wheel', wheel: { direction: 'down', x: 10, y: 5 } });
    }

    assert.equal(viewport.scrollTop, max);
    assert.equal(viewport.following, true, 'following must be retained at bottom');
    assert.equal(surface.detached, false);
  });

  test('rail click preceding/above chat box clamps cleanly to top (0) without freeze', () => {
    const { prompt, surface } = createTestHarness({ rows: 30, columns: 90 });
    const viewport = surface.viewport;

    // Scroll halfway
    viewport.scrollTo(25);
    assert.equal(viewport.scrollTop, 25);

    // Rail column is at right edge (x = 88)
    // Terminal rows = 30. Stage height ~ 29. Click at row 0 (above stage)
    prompt.handleKey({
      name: 'mouse',
      mouse: { button: 0, pressed: true, x: 88, y: 0 }
    });

    assert.equal(viewport.scrollTop, 0, 'click above chat box must clamp cleanly to top 0');
    assert.equal(surface.detached, false);
  });

  test('rail click following/below viewport clamps cleanly to bottom and resumes follow', () => {
    const { prompt, surface } = createTestHarness({ rows: 30, columns: 90 });
    const viewport = surface.viewport;

    viewport.toTop();
    assert.equal(viewport.scrollTop, 0);
    assert.equal(viewport.following, false);

    // Click near bottom of screen on rail column
    prompt.handleKey({
      name: 'mouse',
      mouse: { button: 0, pressed: true, x: 88, y: 29 }
    });

    assert.equal(viewport.scrollTop, viewport.maxScrollTop(), 'click below viewport must clamp to maxScrollTop');
    assert.equal(viewport.following, true, 'click at bottom of rail must resume following');
    assert.equal(surface.detached, false);
  });

  test('rail click inside viewport scrolls to proportional position', () => {
    const { prompt, surface } = createTestHarness({ rows: 30, columns: 90 });
    const viewport = surface.viewport;
    const stageH = surface.stage.height;
    const termRows = 30;
    const stageTop = Math.max(0, termRows - stageH);

    // Click at row stageTop + 5 on the rail
    prompt.handleKey({
      name: 'mouse',
      mouse: { button: 0, pressed: true, x: 88, y: stageTop + 5 }
    });

    assert.ok(viewport.scrollTop > 0, 'rail click must scroll viewport proportionally');
    assert.ok(viewport.scrollTop < viewport.maxScrollTop(), 'middle rail click should be between 0 and max');
    assert.equal(surface.detached, false);
  });

  test('surface auto-heals if previously detached', () => {
    const { prompt, surface } = createTestHarness();
    const viewport = surface.viewport;

    // Simulate an accidental detach
    surface.detached = true;
    surface.mouseCaptured = false;
    prompt.notice = 'top of this view — scrolling with the terminal now; press any key to come back';

    // A wheel event arrives
    prompt.handleKey({ name: 'wheel', wheel: { direction: 'down', x: 10, y: 5 } });

    assert.equal(surface.detached, false, 'wheel event must auto-heal detached state');
    assert.equal(surface.mouseCaptured, true, 'mouse reporting must be re-captured');
    assert.equal(prompt.notice, '', 'notice must be cleared');
  });

  test('plain mouse clicks in chat content do not corrupt input or freeze', () => {
    const { prompt, surface } = createTestHarness();
    prompt.editor.setText('my user command');

    // Click in the middle of content area (not rail)
    prompt.handleKey({
      name: 'mouse',
      mouse: { button: 0, pressed: true, x: 20, y: 10 }
    });

    assert.equal(prompt.editor.getText(), 'my user command', 'input text must not be modified');
    assert.equal(surface.detached, false);
  });
});
