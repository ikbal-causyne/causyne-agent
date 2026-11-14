import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderBanner } from '../src/tui/banner.js';

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
});
