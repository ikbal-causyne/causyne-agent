import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StatusLine } from '../src/tui/statusLine.js';

test('spinner frames cannot smuggle terminal screen-clear or cursor movement sequences', () => {
  const status = new StatusLine();
  for (const frame of ['\x1b[2J⠋', '\x1b[1;1H⠋', '\x1b]0;injected\x07⠋']) {
    const line = status.render({ spinnerFrame: frame, message: 'working', width: 70 });
    assert.doesNotMatch(line, /\x1b\[(?:2J|1;1H)/);
    assert.doesNotMatch(line, /\x1b\]0;/);
    assert.match(line, /⠋/);
  }
});
