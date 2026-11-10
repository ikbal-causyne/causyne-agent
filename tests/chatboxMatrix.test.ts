import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { composerGeometry, fitHomeContent } from '../src/tui/composerGeometry.js';
import { LineEditor } from '../src/tui/lineEditor.js';
import { ChatPrompt } from '../src/tui/prompt.js';
import { visibleWidth, stripAnsi } from '../src/tui/text.js';

function createMockOut(columns: number, rows: number) {
  const fragments: string[] = [];
  return {
    columns,
    rows,
    isTTY: true,
    write(v: string) { fragments.push(v); return true; },
    on() {},
    removeListener() {},
    get output() { return fragments.join(''); },
    clear() { fragments.length = 0; }
  };
}

describe('Chatbox TUI Matrix Verification across 80x24, 100x30, 155x78', () => {
  const dimensions = [
    { cols: 80, rows: 24, name: '80x24' },
    { cols: 100, rows: 30, name: '100x30' },
    { cols: 155, rows: 78, name: '155x78' }
  ];

  for (const { cols, rows, name } of dimensions) {
    test(`Composer geometry bounds valid at ${name}`, () => {
      // Home composer width: clamped between 56 and cols - 2, max 82
      const homeWidth = Math.min(cols - 2, Math.max(56, 82));
      const geom = composerGeometry(homeWidth, 1, 1);
      assert.ok(geom.boxWidth <= cols, `boxWidth ${geom.boxWidth} must fit cols ${cols}`);
      assert.ok(geom.editorWidth > 0, 'editorWidth must be positive');
      assert.ok(geom.inset + geom.editorWidth <= geom.boxWidth, 'editor must fit in box');
      assert.ok(geom.maxCaretCol <= geom.boxWidth, 'caret cannot exceed box width');
    });

    test(`Long sentence does not lose text or overflow at ${name}`, () => {
      const editor = new LineEditor();
      const sentence = 'The quick brown fox jumps over the lazy dog and tests every single character boundary without losing any text in the composer viewport across multiple lines of wrapping.';
      editor.insert(sentence);
      
      const width = Math.min(cols - 6, 78);
      const rendered = editor.render(width, '');
      
      // All characters preserved
      assert.equal(rendered.rows.map(stripAnsi).join(''), sentence);
      assert.equal(editor.getText(), sentence);
      // Caret within bounds
      assert.ok(rendered.cursorCol <= width, `cursorCol ${rendered.cursorCol} exceeds width ${width}`);
      assert.ok(rendered.cursorRow >= 0 && rendered.cursorRow < rendered.rows.length);
      // All rendered rows within column budget
      for (const row of rendered.rows) {
        assert.ok(visibleWidth(row) <= width, `Row "${row}" width ${visibleWidth(row)} exceeds ${width}`);
      }
    });

    test(`Exact-width boundary test at ${name}`, () => {
      const width = Math.min(cols - 6, 78);
      const exactText = 'A'.repeat(width);
      const editor = new LineEditor(exactText);
      const rendered = editor.render(width, '');

      // Exact width should advance caret to next line at col 0
      assert.equal(rendered.rows[0], exactText);
      assert.equal(rendered.cursorRow, 1);
      assert.equal(rendered.cursorCol, 0);
      assert.equal(editor.getText(), exactText);
    });

    test(`CJK and Unicode wide characters layout at ${name}`, () => {
      const width = Math.min(cols - 6, 78);
      const cjkSentence = 'こんにちは世界！这是中文测试。한글 테스트입니다. 🚀 Multi-byte symbols and emoji.';
      const editor = new LineEditor(cjkSentence);
      const rendered = editor.render(width, '');

      assert.equal(editor.getText(), cjkSentence);
      for (const row of rendered.rows) {
        assert.ok(visibleWidth(row) <= width, `CJK row exceeded width: ${visibleWidth(row)} > ${width}`);
      }
      assert.ok(rendered.cursorCol <= width);
    });

    test(`Paste operation (large multi-token chunk) at ${name}`, () => {
      const editor = new LineEditor('initial ');
      const pastedChunk = 'pasted chunk with many tokens 1234567890 !@#$%^&*() and multiple words to verify seamless paste insertion.';
      editor.insert(pastedChunk);
      
      const width = Math.min(cols - 6, 78);
      const rendered = editor.render(width, '');
      assert.equal(editor.getText(), 'initial ' + pastedChunk);
      assert.ok(rendered.rows.length >= 1);
      assert.ok(rendered.cursorCol <= width);
    });

    test(`Editing at start and end of wrapped line at ${name}`, () => {
      const width = Math.min(cols - 6, 78);
      const editor = new LineEditor('middle text that spans several words and rows');
      
      // Move to start
      editor.moveHome();
      assert.equal(editor.col, 0);
      editor.insert('[START] ');
      assert.ok(editor.getText().startsWith('[START] '));
      
      // Move to end
      editor.moveEnd();
      assert.equal(editor.col, editor.lines[editor.line].length);
      editor.insert(' [END]');
      assert.ok(editor.getText().endsWith(' [END]'));

      const rendered = editor.render(width, '');
      assert.ok(rendered.cursorCol <= width);
      assert.ok(rendered.cursorRow >= 0 && rendered.cursorRow <= rendered.rows.length);
    });

    test(`Home view content fitting and prompt presentation at ${name}`, () => {
      const mockOut = createMockOut(cols, rows);
      let capturedFrame: any = null;
      const fakeSurface = {
        homeInfo: { cwd: '/test' },
        width: cols,
        composeWidth: () => Math.min(cols - 2, 82),
        composeAvailableWidth: () => cols,
        stage: { maxHeight: rows },
        present(r: string[], caret: { row: number; col: number }) {
          capturedFrame = { rows: r, caret };
          return true;
        }
      };

      const prompt = new ChatPrompt({ out: mockOut as any, surface: fakeSurface as any });
      prompt.active = true;
      const testInput = 'search we for image download it then change my desktop wallpaper what i want is';
      prompt.editor.setText(testInput);
      prompt.draw();

      assert.ok(capturedFrame, 'Frame must be captured on draw');
      assert.ok(capturedFrame.caret.col <= cols, `Caret col ${capturedFrame.caret.col} must not exceed ${cols}`);
      assert.ok(capturedFrame.caret.row < capturedFrame.rows.length, 'Caret row must be within frame rows');
      
      // Transition from Home to Session: clear homeInfo and draw again
      fakeSurface.homeInfo = null as any;
      capturedFrame = null;
      prompt.draw();
      assert.ok(capturedFrame, 'Session frame must be captured');
      assert.ok(capturedFrame.caret.col <= cols);
      assert.equal(prompt.editor.getText(), testInput, 'Input preserved during transition');
    });

    test(`Terminal resize adaptation from ${name} to altered geometry`, () => {
      const mockOut = createMockOut(cols, rows);
      let capturedFrame: any = null;
      let curCols = cols;
      let curRows = rows;
      const fakeSurface = {
        homeInfo: { cwd: '/test' },
        get width() { return curCols; },
        composeWidth: () => Math.min(curCols - 2, 82),
        composeAvailableWidth: () => curCols,
        stage: { get maxHeight() { return curRows; } },
        present(r: string[], caret: { row: number; col: number }) {
          capturedFrame = { rows: r, caret };
          return true;
        }
      };

      const prompt = new ChatPrompt({ out: mockOut as any, surface: fakeSurface as any });
      prompt.active = true;
      prompt.editor.setText('Resize test input string spanning multiple characters and words.');
      prompt.draw();
      assert.ok(capturedFrame);

      // Simulate window resize
      curCols = cols === 80 ? 120 : 80;
      curRows = rows === 24 ? 40 : 24;
      mockOut.columns = curCols;
      mockOut.rows = curRows;

      prompt.draw();
      assert.ok(capturedFrame);
      assert.ok(capturedFrame.caret.col <= curCols);
      assert.ok(capturedFrame.caret.row < capturedFrame.rows.length);
    });
  }
});
