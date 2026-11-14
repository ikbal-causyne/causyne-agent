import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildContinuumItems, openContinuumPreview } from '../src/continuum/ui/continuumPicker.js';
import { ContinuumPickerLayer, renderContinuumWindow } from '../src/continuum/ui/continuumPickerView.js';

describe('continuumPicker bounds and sanitization', () => {
  it('buildContinuumItems handles non-finite updatedAt, non-finite messageCount, and trailing/Windows slashes in workspacePath', () => {
    const items = buildContinuumItems([
      {
        id: 's1',
        sourcePlatform: 'codex',
        sourceLabel: 'Codex',
        title: 'Session 1',
        workspacePath: '/Users/dev/project/',
        updatedAt: Number.NaN,
        messageCount: Number.NaN,
        snippet: 'test'
      },
      {
        id: 's2',
        sourcePlatform: 'claude_code',
        sourceLabel: 'Claude Code',
        title: 'Session 2',
        workspacePath: 'C:\\Users\\dev\\winproj\\',
        updatedAt: 0,
        messageCount: 1,
        snippet: 'test'
      }
    ]);

    assert.equal(items.length, 2);
    assert.doesNotMatch(items[0]!.description, /\bNaN\b/);
    assert.match(items[0]!.description, /^0 msgs\b/);
    assert.match(items[0]!.description, /project$/);
    assert.match(items[1]!.description, /^1 msg\b/);
    assert.match(items[1]!.description, /winproj$/);
  });

  it('openContinuumPreview sanitizes control and escape sequences from session title and messages', async () => {
    let openedLayer: any = null;
    const ok = await openContinuumPreview(
      's1',
      { openLayer(layer) { openedLayer = layer; } },
      {
        async fetchSession() {
          return {
            id: 's1',
            sourcePlatform: 'codex',
            sourceLabel: 'Codex\x1b[2J',
            title: 'Bad\x1b]0;pwn\x07Title',
            workspacePath: '/tmp/ws\x1b[31m',
            updatedAt: Date.now(),
            messageCount: 1,
            snippet: '',
            messages: [
              { role: 'user', content: 'hello\x1b[2Jworld' }
            ]
          };
        }
      } as any
    );
    assert.equal(ok, true);
    assert.ok(openedLayer);
    assert.equal(openedLayer.title.includes('\x1b'), false);
    const bodyText = openedLayer.lines.join('\n');
    assert.equal(bodyText.includes('\x1b'), false);
    assert.match(bodyText, /helloworld/);
  });

  it('ContinuumPickerLayer.body and renderContinuumWindow handle non-finite dimensions and NaN selected/offset', () => {
    const items = buildContinuumItems([
      {
        id: 's1',
        sourcePlatform: 'codex',
        sourceLabel: 'Codex',
        title: 'Session Alpha',
        workspacePath: '/Users/dev/alpha',
        updatedAt: Date.now() - 120_000,
        messageCount: 1.7,
        snippet: 'alpha snippet'
      }
    ]);
    const layer = new ContinuumPickerLayer({
      sessions: items,
      onPick() {}
    });
    layer.list.selected = Number.NaN;
    layer.list.offset = Number.NaN;

    assert.doesNotThrow(() => {
      const nanRows = layer.body(Number.NaN, Number.NaN);
      assert.ok(nanRows.length >= 1);
      const infRows = layer.body(Number.POSITIVE_INFINITY, 20);
      assert.equal(infRows.length, 20);
      assert.match(infRows.join('\n'), /Session Alpha/);
      assert.match(infRows.join('\n'), /1 msg\b/);
    });

    const win = renderContinuumWindow(layer.list.filtered, Number.NaN, Number.NaN, Number.NaN, Number.NaN);
    assert.ok(Array.isArray(win.rows));
  });
});
