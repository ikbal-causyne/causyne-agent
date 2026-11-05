import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { StageSurface } from '../src/tui/stageSurface.js';
import { ChatRenderer } from '../src/tui/chatRenderer.js';
import { ChatPrompt } from '../src/tui/prompt.js';
import { sessionRows } from '../src/tui/layout.js';
import { sessionMainWidth, sessionComposerWidth } from '../src/tui/sessionSidebar.js';
import { wrapBlock, stripAnsi, visibleWidth } from '../src/tui/text.js';

function createSink(columns = 100, rows = 35) {
  const chunks: string[] = [];
  return {
    columns,
    rows,
    isTTY: true,
    write(text: string) {
      chunks.push(text);
      return true;
    },
    on() {},
    removeListener() {},
    text: () => chunks.join(''),
    reset: () => { chunks.length = 0; },
    chunks
  };
}

describe('TUI Prompt & Transcript Alignment and Symmetry', () => {
  test('User message multi-line wrapping is flush-left with zero hanging indent', () => {
    const longPrompt = 'buatkan aku website sebuah website dari masa depan all in english jadi konsepnya adalah ini adlah website yang seprti di buat dari masa depan tapi karena suatu bugs ini bisa di akses di masa sekarng wich mean design dan lain sebgainya jauh berbeda dari website yang ada di masa kini website adalah tentang website sebuah biotechnologi yan sangt canggih';
    const wrapped = wrapBlock(longPrompt, 60, { hang: 0 });

    assert.ok(wrapped.length >= 3, 'Long prompt wraps into multiple lines');
    for (let i = 0; i < wrapped.length; i++) {
      const line = wrapped[i]!;
      // Every line must not have artificial 2-space leading indent
      assert.ok(!line.startsWith('  '), `Line ${i} should be flush left without 2-space hanging indent: "${line}"`);
    }
  });

  test('Prompt box and transcript blocks have exact horizontal alignment and symmetry in session', () => {
    const out = createSink(120, 35);
    const surface = new StageSurface({ out, env: { CAUSYNE_RAIL: '1', CAUSYNE_SIDEBAR: '0' } });
    surface.open();

    try {
      const renderer = new ChatRenderer({ out, transcript: surface.transcript });
      const prompt = new ChatPrompt({ out, surface, renderer });

      // Turn 0: empty session
      assert.equal(surface.composeInset(), 2, 'Empty session has standard 2-column inset');

      // Turn 1: user submits prompt
      surface.leaveHome();
      renderer.renderUserMessage('Hello Causyne Agent, create the project');
      surface.present(['status line'], { row: 0, col: 0 });

      // After user turn exists, turn rail is active:
      assert.equal(surface.composeInset(), 3, 'Session with turns reserves exactly 3 columns for turn rail');

      const mainWidth = sessionMainWidth(120);
      const expectedContentWidth = mainWidth - 3 - 3; // mainWidth - RAIL_BUDGET (3) - turnRailBudget (3)
      assert.equal(surface.composeWidth(), expectedContentWidth, 'composeWidth matches contentWidth exactly');

      // Prompt positioning with sessionRows using composeInset
      const positioned = sessionRows(['[composer]'], mainWidth, surface.composeInset());
      assert.equal(positioned.inset, 3, 'Prompt rows receive 3 columns of left inset');
      assert.ok(positioned.rows[0]?.startsWith('   [composer]'), 'Prompt row starts at column 3');
    } finally {
      surface.close();
    }
  });
});
