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

      // Verify sessionRows places rows with established 3-space inset
      const positioned = sessionRows(['[composer]'], mainWidth);
      assert.equal(positioned.inset, 3, 'Prompt rows receive established 3 columns of left inset');
      assert.ok(positioned.rows[0]?.startsWith('   [composer]'), 'Prompt row starts at established column 3');
    } finally {
      surface.close();
    }
  });

  test('Transcript rows and prompt box bars align at exact column 3 when turns exist, with breathing space for dot', () => {
    const out = createSink(120, 35);
    const surface = new StageSurface({ out, env: { CAUSYNE_RAIL: '1', CAUSYNE_SIDEBAR: '0' } });
    surface.open();

    try {
      const renderer = new ChatRenderer({ out, transcript: surface.transcript });
      const prompt = new ChatPrompt({ out, surface, renderer });
      prompt.active = true;

      // Add user turn
      renderer.renderUserMessage('Hello from user turn');

      prompt.draw();
      const band = surface.stage.prev;
      assert.ok(band.length > 0, 'Stage has painted rows');

      // Find transcript row with message text
      const transcriptRow = band.find((r: string) => stripAnsi(r).includes('Hello from user turn'));
      assert.ok(transcriptRow, 'Transcript row exists in painted band');
      const plainTranscript = stripAnsi(transcriptRow);
      const transcriptBarCol = plainTranscript.search(/[┃|]/);
      assert.equal(transcriptBarCol, 3, `Transcript accent bar should be at column 3, got ${transcriptBarCol}`);

      // Check turn dot in column 1 on preceding or current turn row
      const dotRow = band.find((r: string) => stripAnsi(r).includes('●') || stripAnsi(r).includes('•'));
      assert.ok(dotRow, 'Turn dot should be present in painted band');
      const plainDot = stripAnsi(dotRow);
      const dotCol = plainDot.search(/[●•]/);
      assert.equal(dotCol, 1, `Turn dot should sit in column 1 of left margin, got ${dotCol}`);
      // Column 2 must be whitespace breathing room between the dot and the vertical bar
      assert.equal(plainDot[2], ' ', 'Column 2 must be an air column providing breathing space before the bar');

      // Find prompt box row with accent bar
      const promptRow = band.find((r: string) => stripAnsi(r).includes('try "') || stripAnsi(r).includes('type to queue'));
      assert.ok(promptRow, 'Prompt row exists in painted band');
      const plainPrompt = stripAnsi(promptRow);
      const promptBarCol = plainPrompt.search(/[┃|]/);
      assert.equal(promptBarCol, 3, `Prompt accent bar should be at column 3, got ${promptBarCol}`);

      // Both must match exactly at column 3
      assert.equal(transcriptBarCol, promptBarCol, 'Transcript and prompt bars must align at identical column');
    } finally {
      surface.close();
    }
  });
});
