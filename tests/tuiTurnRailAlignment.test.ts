import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StageSurface } from '../src/tui/stageSurface.js';
import { ChatRenderer } from '../src/tui/chatRenderer.js';
import { stripAnsi } from '../src/tui/text.js';

test('turn rail dots stay anchored to the bottom-aligned transcript in a full-height session instead of floating in upper empty space', () => {
  const out = {
    columns: 193,
    rows: 78,
    isTTY: true,
    write: () => true,
    on() {},
    removeListener() {}
  };
  const surface = new StageSurface({ out, env: { CAUSYNE_MOUSE: '0', CAUSYNE_RAIL: '1' } });
  assert.equal(surface.open(), true);
  try {
    surface.enterHome({ version: 'v1', provider: 'acp/opencode', model: 'deepseek-v4.1-flash-free', cwd: '/tmp/work' });
    surface.leaveHome(true);

    const renderer = new ChatRenderer({ out, transcript: surface.transcript });
    renderer.renderUserMessage('hi');
    renderer.renderAssistantMessage('Hi. What would you like to build or work on?');

    surface.present(['   ┃ try "review"', '   Build C'], { row: 0, col: 4 });

    const plainRows = surface.stage.prev.map((r: string) => stripAnsi(r));
    const userRowIdx = plainRows.findIndex((r: string) => r.includes('hi'));
    const dotRowIdx = plainRows.findIndex((r: string) => r.includes('●'));

    assert.ok(userRowIdx > 40, `Expected bottom-aligned user message near bottom of 77-row stage, got row ${userRowIdx}`);
    assert.ok(dotRowIdx >= userRowIdx - 1, `Expected turn rail dot ● near bottom-aligned transcript (row >= ${userRowIdx - 1}), but found floating at row ${dotRowIdx}`);
  } finally {
    surface.close();
  }
});
