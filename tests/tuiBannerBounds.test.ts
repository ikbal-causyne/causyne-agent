import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderBanner, fitHints, detect } from '../src/tui/banner.js';

describe('banner bounds', () => {
  it('renderBanner does not emit ellipsis tail characters when available metadata width maxw <= 0', () => {
    const out = renderBanner({
      variant: 'full',
      width: 22,
      height: 24,
      color: 'none',
      unicode: true,
      provider: 'openai',
      model: 'gpt-5',
      cwd: '/tmp/project'
    });

    assert.equal(out.includes('…'), false);
    assert.equal(out.includes('~'), false);
  });

  it('fitHints returns empty string when width is non-finite or non-positive', () => {
    assert.equal(fitHints(['/ commands', '@ files'], 0, 'ask anything'), '');
    assert.equal(fitHints(['/ commands', '@ files'], -4, 'ask anything'), '');
    assert.equal(fitHints(['/ commands', '@ files'], Number.NaN, 'ask anything'), '');
    assert.equal(fitHints(['/ commands', '@ files'], Number.POSITIVE_INFINITY, 'ask anything'), '/ commands  ·  @ files');
  });

  it('detect falls back cleanly when explicit or stream terminal dimensions are non-finite, non-positive, or fractional', () => {
    const fromInf = detect(
      { width: Number.POSITIVE_INFINITY, height: -5 },
      { columns: 100.8, rows: Number.NaN, isTTY: false }
    );
    assert.equal(fromInf.width, 100);
    assert.equal(fromInf.height, 24);
  });
});
