import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleScrollbarMouse } from '../src/tui/scrollInteraction.js';

test('completion picker mouse region accounts for a stage anchored below terminal scrollback', () => {
  let scrolls = 0;
  const viewport: any = { height: 16, maxScrollTop: () => 100,
    scrollTo: () => { scrolls++; }, toBottom: () => { scrolls++; } };
  const surface: any = { stage: { height: 20, width: () => 80 }, railEnabled: () => true };
  const host: any = {
    out: { rows: 50 },
    notice: '',
    pickerLayout: { pickerStart: 3, pickerCount: 3, totalPromptRows: 6 },
    draw() {}
  };
  // Stage occupies terminal rows 31-50; picker begins at terminal row 47.
  const pickerClick = { name: 'mouse', mouse: { x: 78, y: 47, button: 0, pressed: true } };
  assert.equal(handleScrollbarMouse(pickerClick, viewport, surface, host), false);
  assert.equal(scrolls, 0);
  assert.equal(handleScrollbarMouse({ name: 'mouse', mouse: { x: 78, y: 35, button: 0, pressed: true } }, viewport, surface, host), true);
  assert.equal(scrolls, 1);
});
