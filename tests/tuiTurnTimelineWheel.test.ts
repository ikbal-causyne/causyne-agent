import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatPrompt } from '../src/tui/prompt.js';
import { handleTurnRailMouse } from '../src/tui/turnRail.js';

test('wheel in the timeline popover paginates turns and never scrolls chat behind it', () => {
  let redrawn = 0;
  let chatWheels = 0;
  const surface: any = {
    turnRailCardOffset: 0,
    turnRailLayout: {
      stageTop: 4,
      cardRect: {
        x: 4, y: 6, width: 42, height: 12,
        groupTurns: Array.from({ length: 23 }, (_, i) => ({ turnIndex: i + 1 })),
        maxOffset: 16, entries: [], entryStart: 4
      }
    },
    viewport: { wheel: () => { chatWheels++; } }
  };
  const prompt: any = {
    surface,
    renderer: null,
    scheduleDraw() { redrawn++; }
  };
  const wheel = (direction: string, x = 20, y = 14) =>
    ChatPrompt.prototype.handleScrollKey.call(prompt, {
      name: 'wheel', wheel: { direction, x, y }
    });
  assert.equal(wheel('down'), true);
  assert.equal(surface.turnRailCardOffset, 1);
  assert.equal(wheel('down'), true);
  assert.equal(surface.turnRailCardOffset, 2);
  assert.equal(wheel('up'), true);
  assert.equal(surface.turnRailCardOffset, 1);
  assert.equal(chatWheels, 0);
  assert.equal(redrawn, 3);
  for (let i = 0; i < 30; i++) wheel('down');
  assert.equal(surface.turnRailCardOffset, 16);
  assert.equal(chatWheels, 0);
  assert.equal(wheel('down'), true, 'wheel at card limit stays inside the card');
  assert.equal(chatWheels, 0);
});

test('moving over the left border of a timeline card does not select a different rail dot', () => {
  let changed = 0;
  const surface: any = {
    hoveredTurnIndex: 10,
    hoveredTurnAnchorY: 6,
    turnRailLayout: {
      railX: 1, stageTop: 0, viewportHeight: 20,
      rowToTurn: new Map([[4, 20]]), dotRows: new Map([[20, 4], [10, 6]]),
      cardRect: { x: 4, y: 2, width: 42, height: 12, turnIndex: 10 },
      turns: [{ turnIndex: 10 }, { turnIndex: 20 }]
    }
  };
  const event = { mouse: { x: 4, y: 4, button: 3, pressed: false },
    sequence: '\x1b[<35;5;5M' };
  assert.equal(handleTurnRailMouse(event, surface, { scheduleDraw() { changed++; } }), true);
  assert.equal(surface.hoveredTurnIndex, 10, 'card overlap must not retarget a rail dot');
  assert.equal(changed, 0);
});
