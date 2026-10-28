import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSubprocessOutput, stripAnsi } from '../src/tools/sysRun.js';

describe('cleanSubprocessOutput', () => {
  it('strips ANSI escape codes cleanly', () => {
    const raw = '\u001b[31mRed text\u001b[0m and \u001b[1mBold text\u001b[0m';
    assert.equal(cleanSubprocessOutput(raw), 'Red text and Bold text');
  });

  it('normalizes carriage returns and CRLF to LF', () => {
    const raw = 'line1\r\nline2\rline3\n';
    assert.equal(cleanSubprocessOutput(raw), 'line1\nline2\nline3\n');
  });

  it('filters curl and wget progress meters so history and UI do not glitch', () => {
    const curlOutput = [
      '  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current',
      '                                 Dload  Upload   Total   Spent    Left  Speed',
      '  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0',
      '100  4108  100  4108    0     0  28741      0 --:--:-- --:--:-- --:--:-- 28929',
      'HTTP 200 OK',
      'Content-Type: text/html',
    ].join('\n');

    const cleaned = cleanSubprocessOutput(curlOutput);
    assert.ok(!cleaned.includes('% Total'));
    assert.ok(!cleaned.includes('Dload  Upload'));
    assert.ok(!cleaned.includes('--:--:--'));
    assert.ok(cleaned.includes('HTTP 200 OK'));
    assert.ok(cleaned.includes('Content-Type: text/html'));
  });
});
