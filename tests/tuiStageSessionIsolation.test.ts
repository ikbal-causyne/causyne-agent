import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StageSurface } from '../src/tui/stageSurface.js';
import { stripAnsi } from '../src/tui/text.js';

test('switching sessions clears old sidebar plans and stale turn-selection state', () => {
  const out = { columns: 200, rows: 40, isTTY: true, write: () => true, on() {}, removeListener() {} };
  const surface = new StageSurface({ out, env: { CAUSYNE_MOUSE: '0' } });
  assert.equal(surface.open(), true);
  try {
    surface.enterHome({ cwd: '/tmp/work' });
    surface.leaveHome(true);
    surface.setSessionInfo({ id: 'one', title: 'One', activeSkill: 'old/skill', contextChars: 4200 });
    surface.sidebarPlan = [{ text: 'Old plan', status: 'in_progress' }];
    surface.hoveredTurnIndex = 1;
    surface.activeTurnIndex = 1;
    surface.hoveredTurnAnchorY = 7;
    surface.setSessionInfo({ id: 'two', title: 'Two' });
    assert.deepEqual(surface.sidebarPlan, []);
    assert.equal(surface.sessionInfo.activeSkill, null);
    assert.equal(surface.sessionInfo.contextChars, 0);
    assert.equal(surface.hoveredTurnIndex, null);
    assert.equal(surface.activeTurnIndex, null);
    surface.commit('user', () => ['hello']);
    surface.present(['INPUT'], { row: 0, col: 0 });
    assert.doesNotMatch(stripAnsi(surface.stage.prev.join('\n')), /Old plan/);
    surface.sidebarPlan = [{ text: 'Current plan', status: 'in_progress' }];
    surface.setSessionInfo({ id: 'two', title: 'Two updated' });
    assert.equal(surface.sidebarPlan.length, 1, 'in-session metadata updates preserve the current plan');
  } finally {
    surface.close();
  }
});
