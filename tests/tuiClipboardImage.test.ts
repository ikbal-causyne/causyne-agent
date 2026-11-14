import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { formatByteSize, persistImageBuffer } from '../src/tui/clipboardImage.js';

describe('clipboardImage bounds and path safety', () => {
  it('formatByteSize clamps negative and non-finite byte sizes to 0 B', () => {
    assert.equal(formatByteSize(-5), '0 B');
    assert.equal(formatByteSize(Number.NaN), '0 B');
    assert.equal(formatByteSize(Number.POSITIVE_INFINITY), '0 B');
  });

  it('persistImageBuffer falls back to generated filename when preferredName resolves to directory or empty', () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const badName of ['..', '.', 'sub/..', '///', '   ']) {
      const attachment = persistImageBuffer(pngHeader, badName);
      assert.ok(attachment);
      assert.match(path.basename(attachment.path), /^screenshot_\d+\.png$/);
    }
  });
});
