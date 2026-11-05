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

  test('Both chatbox and chat interface share the established session composer width and margin', () => {
    const out = createSink(120, 35);
    const surface = new StageSurface({ out, env: { CAUSYNE_RAIL: '1', CAUSYNE_SIDEBAR: '0' } });
    surface.open();

    try {
      const renderer = new ChatRenderer({ out, transcript: surface.transcript });
      const prompt = new ChatPrompt({ out, surface, renderer });

      const mainWidth = sessionMainWidth(120);
      const expectedWidth = sessionComposerWidth(mainWidth);

      // Verify established composeWidth matches sessionComposerWidth
      assert.equal(surface.composeWidth(), expectedWidth, 'composeWidth matches sessionComposerWidth exactly');

      // Verify sessionRows places rows with established 2-space inset
      const positioned = sessionRows(['[composer]'], mainWidth);
      assert.equal(positioned.inset, 2, 'Prompt rows receive established 2 columns of left inset');
      assert.ok(positioned.rows[0]?.startsWith('  [composer]'), 'Prompt row starts at established column 2');
    } finally {
      surface.close();
    }
  });
});
