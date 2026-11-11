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
    const sentence = 'dokumen sudah diubah kedalam bahasa indonesia dan juga sudah di verifikasi oleh tim ahli bahasa indonesia dan tidak ada lagi sisa bahasa inggris';
    editor.insert(sentence);

    const layout = editor.render(70, '');
    assert.ok(layout.rows.length >= 2, 'Sentence wraps into at least 2 display rows at width 70');
    // Verify word boundary wrap (does not split words mid-word)
    assert.ok(!layout.rows[0]?.endsWith('-'), 'Row 0 does not have hyphen break');
    assert.ok(layout.rows[0]?.endsWith(' '), 'Row 0 cleanly breaks after a word and whitespace');
    assert.equal(layout.cursorRow, layout.rows.length - 1, 'Caret sits on the last wrapped row');
    assert.ok(layout.cursorCol > 0, 'Caret column is tracked on the active display row');
  });

  test('Composer width conforms dynamically using smart scaling algorithm on wide terminals', () => {
    // Normal columns reserve three cells of inset and one final safety column
    assert.equal(sessionComposerWidth(80), 76);
    assert.equal(sessionComposerWidth(100), 96);
    assert.equal(sessionComposerWidth(111), 107);

    // Wide terminals: widens smoothly without stretching excessively across hundreds of columns
    const width140 = sessionComposerWidth(140);
    const width200 = sessionComposerWidth(200);

    assert.ok(width140 > 108 && width140 < 137, `Width at 140 columns (${width140}) is bounded and comfortable`);
    assert.ok(width200 > width140 && width200 < 150, `Width at 200 columns (${width200}) preserves readable measure`);
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
      const sentence = 'dokumen sudah diubah kedalam bahasa indonesia dan diverifikasi oleh tim ahli bahasa indonesia dan tidak ada lagi sisa bahasa inggris';
      prompt.editor.insert(sentence);
      prompt.draw();

      const wrappedPrev = [...surface.stage.prev];
      const wrappedScreen = stripAnsi(wrappedPrev.join('\n'));

      // Both halves of sentence must be visible on screen
      assert.ok(wrappedScreen.includes('dokumen sudah diubah'), 'First part of text is present on screen');
      assert.ok(wrappedScreen.includes('sisa bahasa inggris'), 'Last part of text is present on screen and not truncated');

      // The rightmost characters must not be clipped off
      assert.ok(!wrappedScreen.includes('sisa bahasa inggri\n'), 'Last character must not be truncated to inggri');
    } finally {
      surface.close();
    }
  });
});
