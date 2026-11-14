import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StageSurface } from '../src/tui/stageSurface.js';
import { stripAnsi } from '../src/tui/text.js';

test('sidebar uses measured session context when no separate sidebar status frame exists', () => {
  const out = { columns: 200, rows: 40, isTTY: true, write: () => true, on() {}, removeListener() {} };
  const surface = new StageSurface({ out, env: { CAUSYNE_MOUSE: '0' } });
  assert.equal(surface.open(), true);
  try {
    surface.enterHome({ cwd: '/tmp/project', provider: 'example', model: 'test' });
    surface.leaveHome(true);
    surface.setSessionInfo({ contextChars: 1800, contextLimit: 7200 });
    surface.commit('user', () => ['hi']);
    surface.present(['INPUT'], { row: 0, col: 0 });
    assert.match(stripAnsi(surface.stage.prev.join('\n')), /25% of available window/);

    surface.sidebarStatus = { contextChars: 0, contextLimit: 7200 };
    surface.present(['INPUT'], { row: 0, col: 0 });
    assert.match(stripAnsi(surface.stage.prev.join('\n')), /No context measurement yet/);
  } finally {
    surface.close();
  }
});
