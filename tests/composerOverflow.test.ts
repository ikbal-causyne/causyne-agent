import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { composerGeometry, fitHomeContent } from '../src/tui/composerGeometry.js';
import { LineEditor } from '../src/tui/lineEditor.js';
import { ChatPrompt } from '../src/tui/prompt.js';
import { visibleWidth, stripAnsi } from '../src/tui/text.js';

function mockOut(columns = 155, rows = 78) {
  const fragments: string[] = [];
  return {
    columns, rows, isTTY: true,
    write(value: string) { fragments.push(value); return true; },
    on() {}, removeListener() {},
    get output() { return fragments.join(''); }
  };
}

describe('Causyne composer right-edge and resize regressions', () => {
  test('Home composer reserves a full caret cell at 155-column terminal width', () => {
    // composerWidth(155)=82 in v1.20.93; bar + gutter consumes 2 columns.
    const geometry = composerGeometry(82, 1, 1);
    assert.deepEqual(geometry, {
      boxWidth: 81, inset: 2, bodyWidth: 79,
      editorWidth: 78, maxCaretCol: 80
    });
    assert.ok(geometry.inset + geometry.editorWidth < geometry.boxWidth);
  });

  test('a filled editing row moves its caret onto the next visible row', () => {
    const editor = new LineEditor('x'.repeat(78));
    const rendered = editor.render(78, '');
    assert.deepEqual(rendered.rows, ['x'.repeat(78), '']);
    assert.equal(rendered.cursorRow, 1);
    assert.equal(rendered.cursorCol, 0);
    assert.equal(editor.getText(), 'x'.repeat(78), 'Rendering must not edit the original text');
  });

  test('the screenshot-style draft wraps rather than being cropped', () => {
    const input = 'search we for image download it then change my desktop wallpaper what i want is';
    const editor = new LineEditor(input);
    const rendered = editor.render(78, '');
    assert.ok(rendered.rows.length >= 2);
    assert.equal(rendered.rows.map(stripAnsi).join(''), input);
    assert.ok(rendered.cursorCol < 78);
  });

  test('wide characters cannot place the caret past the inner width', () => {
    const editor = new LineEditor('漢'.repeat(39)); // exactly 78 terminal cells
    const layout = editor.render(78);
    assert.equal(layout.cursorRow, 1);
    assert.equal(layout.cursorCol, 0);
    for (const row of layout.rows) assert.ok(visibleWidth(row) <= 78);
  });

  test('cursor motion inside a wrapped draft follows the logical character position', () => {
    const editor = new LineEditor('prefix ' + 'hello'.repeat(25));
    editor.moveHome();
    editor.moveRight();
    const rendered = editor.render(24, '');
    assert.equal(rendered.cursorRow, 0);
    assert.equal(rendered.cursorCol, 1);
    assert.equal(editor.getText(), 'prefix ' + 'hello'.repeat(25));
  });

  test('the real ChatPrompt never places its Home caret beyond the painted box', () => {
    const out = mockOut();
    let captured: null | { rows: string[]; caret: { row: number; col: number } } = null;
    const fakeSurface = {
      homeInfo: { cwd: '/tmp' }, width: 155,
      composeWidth: () => 82,
      composeAvailableWidth: () => 155,
      stage: { maxHeight: 78 },
      present(rows: string[], caret: { row: number; col: number }) {
        captured = { rows, caret }; return true;
      }
    };
    const prompt = new ChatPrompt({ out: out as any, surface: fakeSurface as any });
    prompt.active = true;
    const draft = 'search we for image download it then change my desktop wallpaper what i want is';
    prompt.editor.setText(draft);
    prompt.draw();
    assert.ok(captured, 'The prompt must paint a frame');
    const frame = captured as unknown as { rows: string[]; caret: { row: number; col: number } };
    assert.ok(frame.rows.some(r => stripAnsi(r).includes('search we for image')));
    assert.ok(frame.rows.some(r => stripAnsi(r).includes('what i want')));
    assert.ok(frame.rows.some(r => stripAnsi(r).includes('is')));
    assert.ok(frame.caret.col < 155);
    assert.ok(frame.caret.row >= 0 && frame.caret.row < frame.rows.length);
    assert.equal(prompt.editor.getText(), draft, 'Display must not alter user input');
  });

  test('ordinary prompt rendering wraps into a second body row without lost characters', () => {
    const out = mockOut(82, 40);
    const prompt = new ChatPrompt({ out: out as any });
    prompt.active = true;
    const draft = 'search we for image download it then change my desktop wallpaper what i want is';
    prompt.editor.setText(draft);
    prompt.draw();
    const painted = stripAnsi(out.output);
    assert.ok(painted.includes('search we for image'));
    assert.ok(painted.includes('what i want') && painted.includes('is'));
    assert.equal(prompt.editor.getText(), draft);
  });

  test('Home placement preserves every normal row when there is room', () => {
    const a = fitHomeContent(['banner1', 'banner2'], ['editor', 'status'], 78, 0, 2);
    assert.deepEqual(a.logoRows, ['banner1', 'banner2']);
    assert.deepEqual(a.promptRows, ['editor', 'status']);
    assert.equal(a.spacer, 2);
    assert.equal(a.caretRow, 0);
  });

  test('Home placement yields banner space before cutting the composer', () => {
    const a = fitHomeContent(['logo1', 'logo2', 'logo3', 'logo4'], ['editor', 'status'], 3, 0, 1);
    assert.deepEqual(a.logoRows, [], 'A partial brand mark must not be shown');
    assert.ok(a.logoRows.length + a.spacer + a.promptRows.length <= 3);
    assert.deepEqual(a.promptRows, ['editor', 'status']);
    assert.equal(a.caretRow, 0);
  });

  test('Home with no logo budget never accidentally includes the entire logo', () => {
    const fitted = fitHomeContent(['big1', 'big2'], ['editor', 'status'], 2, 0, 1);
    assert.deepEqual(fitted.logoRows, []);
    assert.deepEqual(fitted.promptRows, ['editor', 'status']);
  });

  test('very small Home view retains a visible caret in a long editor', () => {
    const rows = Array.from({ length: 16 }, (_, i) => `row${i}`);
    const a = fitHomeContent(['logo1', 'logo2'], rows, 4, 10, 1);
    assert.equal(a.promptRows.length, 4);
    assert.ok(a.caretRow >= 0 && a.caretRow < 4);
    assert.ok(a.promptRows.includes('row10'));
  });

  test('nonfinite geometry inputs fall back to bounded, valid output', () => {
    const a = composerGeometry(Number.NaN, Number.NaN, Number.NaN);
    assert.equal(a.boxWidth, 79);
    assert.ok(a.editorWidth > 0 && a.editorWidth < a.boxWidth);
    const b = fitHomeContent([], [], Number.NaN, Number.NaN, Number.NaN);
    assert.equal(b.promptRows.length, 1);
    assert.equal(b.caretRow, 0);
  });
});
