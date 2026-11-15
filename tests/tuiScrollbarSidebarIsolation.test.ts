import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleScrollbarMouse } from '../src/tui/scrollInteraction.js';
import { sessionMainWidth } from '../src/tui/sessionSidebar.js';

test('clicking the sidebar boundary cannot scroll the conversation viewport', () => {
  let navigated = 0;
  const viewport: any = { height: 20, maxScrollTop: () => 100,
    scrollTo: () => { navigated++; }, toBottom: () => { navigated++; } };
  const surface: any = { width: 200, stage: { height: 35, width: () => 200 },
    env: {}, railEnabled: () => true, activeTurnIndex: 3 };
  const host: any = { out: { rows: 40 }, draw() {} };
  const mainWidth = sessionMainWidth(200, false, surface.env);
  assert.ok(mainWidth < 200);
  assert.equal(handleScrollbarMouse({
    name: 'mouse', mouse: { x: mainWidth, y: 12, button: 0, pressed: true }
  }, viewport, surface, host), false, 'first sidebar column is not scrollbar input');
  assert.equal(navigated, 0);
  assert.equal(surface.activeTurnIndex, 3);
  assert.equal(handleScrollbarMouse({
    name: 'mouse', mouse: { x: mainWidth - 1, y: 12, button: 0, pressed: true }
  }, viewport, surface, host), true, 'last conversation column remains a scrollbar target');
  assert.equal(navigated, 1);
});
