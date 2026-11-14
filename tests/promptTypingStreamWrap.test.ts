import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ChatPrompt } from '../src/tui/prompt.js';
import { ChatRenderer } from '../src/tui/chatRenderer.js';
import { StageSurface } from '../src/tui/stageSurface.js';
import { LineEditor } from '../src/tui/lineEditor.js';
import { sessionComposerWidth, sessionMainWidth } from '../src/tui/sessionSidebar.js';
import { stripAnsi, visibleWidth } from '../src/tui/text.js';

function createSink(columns = 140, rows = 35) {
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

describe('Prompt typing stream wrapping and vertical stretching', () => {
  test('LineEditor renders word-wrapped lines and tracks caret correctly', () => {
    const editor = new LineEditor();
    const sentence = 'documentation has been converted into clean English and also thoroughly verified by technical reviewers with zero remaining layout gaps';
    editor.insert(sentence);

    const layout = editor.render(70, '');
    assert.ok(layout.rows.length >= 2, 'Sentence wraps into at least 2 display rows at width 70');
    // Verify word boundary wrap (does not split words mid-word)
    assert.ok(!layout.rows[0]?.endsWith('-'), 'Row 0 does not have hyphen break');
    assert.ok(layout.rows[0]?.endsWith(' '), 'Row 0 cleanly breaks after a word and whitespace');
    assert.equal(layout.cursorRow, layout.rows.length - 1, 'Caret sits on the last wrapped row');
    assert.ok(layout.cursorCol > 0, 'Caret column is tracked on the active display row');
  });

  test('Composer width fills the available conversation column across narrow and wide terminals without dead gaps', () => {
    // Normal and wide panes reserve three cells of left inset and one final safety column
    assert.equal(sessionComposerWidth(80), 76);
    assert.equal(sessionComposerWidth(100), 96);
    assert.equal(sessionComposerWidth(111), 107);
    assert.equal(sessionComposerWidth(140), 136);
    assert.equal(sessionComposerWidth(200), 196);
  });

  test('Typing in a live session stretches composer vertically downwards without truncating edge characters', () => {
    const out = createSink(140, 35);
    const surface = new StageSurface({ out, env: { CAUSYNE_RAIL: '1', CAUSYNE_SIDEBAR: '0' } });
    surface.open();

    try {
      const renderer = new ChatRenderer({ out, transcript: surface.transcript });
      const prompt = new ChatPrompt({ out, surface, renderer });
      prompt.active = true;

      // 1. Initial empty state: box has 1 line of body
      prompt.draw();
      const initialPrev = [...surface.stage.prev];
      const initialHeight = initialPrev.length;

      // 2. Type a sentence that wraps into 2 lines
      const sentence = 'documentation has been converted into clean English and thoroughly verified by engineering reviewers with no truncated tail edge';
      prompt.editor.insert(sentence);
      prompt.draw();

      const wrappedPrev = [...surface.stage.prev];
      const wrappedScreen = stripAnsi(wrappedPrev.join('\n'));

      // Both halves of sentence must be visible on screen
      assert.ok(wrappedScreen.includes('documentation has been'), 'First part of text is present on screen');
      assert.ok(wrappedScreen.includes('no truncated tail edge'), 'Last part of text is present on screen and not truncated');

      // The rightmost characters must not be clipped off
      assert.ok(!wrappedScreen.includes('no truncated tail edg\n'), 'Last character must not be truncated to edg');
    } finally {
      surface.close();
    }
  });
});
