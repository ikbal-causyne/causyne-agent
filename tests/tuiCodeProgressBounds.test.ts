import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StreamingCodePreview, NativeCodeObserver, codeProgressFromAction, renderCodeProgress } from '../src/tui/codeProgress.js';
import { stripAnsi, visibleWidth } from '../src/tui/text.js';

describe('codeProgress finite bounds', () => {
  it('renderCodeProgress clamps non-finite and sub-12 widths without RangeError', () => {
    const event = codeProgressFromAction('fs_write', {
      path: 'src/app.ts',
      content: 'export const ok = true;\n'
    });
    assert.ok(event);
    assert.doesNotThrow(() => {
      const infRows = renderCodeProgress(event, Number.POSITIVE_INFINITY);
      assert.equal(visibleWidth(infRows[0]!), 80);

      const nanRows = renderCodeProgress(event, Number.NaN);
      assert.equal(visibleWidth(nanRows[0]!), 80);

      const negRows = renderCodeProgress(event, Number.NEGATIVE_INFINITY);
      assert.equal(visibleWidth(negRows[0]!), 80);

      const tinyRows = renderCodeProgress(event, 0.5);
      assert.equal(visibleWidth(tinyRows[0]!), 12);
    });
  });

  it('renderCodeProgress falls back to defaultPreviewStart when startLine is non-finite', () => {
    const event = codeProgressFromAction('fs_write', {
      path: 'src/app.ts',
      content: 'export const alpha = 1;\nexport const beta = 2;\n'
    });
    assert.ok(event);
    const nanStart = renderCodeProgress(event, 80, '', Number.NaN).join('\n');
    assert.match(nanStart, /export const alpha = 1;/);
    assert.doesNotMatch(nanStart, /\bNaN\b/);
  });

  it('StreamingCodePreview.accept emits on initial low timestamp and recovers from non-finite or out-of-order now', () => {
    const preview = new StreamingCodePreview();
    preview.accept('```ts\n', 0);
    const first = preview.accept('const a = 1;', 50);
    assert.ok(first, 'should emit first non-newline draft at now=50 when nothing was sent before');
    assert.equal(first?.code, 'const a = 1;');

    const nanTime = preview.accept(' const b = 2;', Number.POSITIVE_INFINITY);
    assert.ok(nanTime);
    const next = preview.accept(' const c = 3;', 200);
    assert.ok(next, 'should not remain permanently throttled after non-finite now');
    assert.match(next?.code || '', /const c = 3;/);
  });

  it('NativeCodeObserver rejects paths outside workspaceRoot and renderCodeProgress keeps header rows single-line', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-codeobs-'));
    const workspace = path.join(tmpBase, 'ws');
    fs.mkdirSync(workspace, { recursive: true });
    const outsideFile = path.join(tmpBase, 'outside-secret.ts');
    fs.writeFileSync(outsideFile, 'export const secret = 42;\n', 'utf8');

    const emitted: unknown[] = [];
    const observer = new NativeCodeObserver(workspace, ev => emitted.push(ev));
    try {
      observer.handle({
        type: 'code_progress',
        id: 'escape-1',
        phase: 'done',
        operation: 'Creating',
        path: '../outside-secret.ts',
        description: 'Creating ../outside-secret.ts',
        source: 'tool'
      });
      assert.equal(emitted.length, 0, 'NativeCodeObserver must never read outside workspaceRoot');
    } finally {
      observer.dispose();
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }

    const rows = renderCodeProgress({
      type: 'code_progress',
      id: 'hdr-1',
      phase: 'working',
      operation: 'Editing\x1b[2J',
      path: 'src/a.ts\n../../evil',
      description: 'Editing\nsmuggled row\r\nmore',
      code: 'export const x = 1;',
      source: 'tool'
    }, 60, 'note\nline2');
    for (const row of rows) {
      assert.equal(row.includes('\n'), false, 'panel row must not carry raw newlines');
      assert.equal(stripAnsi(row).includes('\x1b'), false);
      assert.ok(!row.includes('\x1b[2J'));
      assert.equal(visibleWidth(row), 60);
    }
  });
});
