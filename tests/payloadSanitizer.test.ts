import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateMediaPayload, detectMagicFormat, sanitizeTextPayload } from '../src/tools/payloadSanitizer.js';

describe('payloadSanitizer', () => {
  it('detects magic numbers for common media types', () => {
    const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46]);
    const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    const wav = Buffer.from('RIFF....WAVE', 'ascii');
    const mp3 = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00]);
    const mp4 = Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]); // ftyp

    assert.equal(detectMagicFormat(png), 'png');
    assert.equal(detectMagicFormat(jpeg), 'jpeg');
    assert.equal(detectMagicFormat(gif), 'gif');
    assert.equal(detectMagicFormat(wav), 'wav');
    assert.equal(detectMagicFormat(mp3), 'mp3');
    assert.equal(detectMagicFormat(mp4), 'mp4');
    assert.equal(detectMagicFormat(Buffer.from('not-media')), null);
  });

  it('validates image payload within size bounds', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(100)]);
    const res = validateMediaPayload(png, 'image');
    assert.equal(res.valid, true);
    assert.equal(res.detectedFormat, 'png');
  });

  it('rejects oversized payloads', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(100)]);
    const res = validateMediaPayload(png, 'image', { maxImageBytes: 50 });
    assert.equal(res.valid, false);
    assert.match(res.error || '', /exceeds allowed limit/);
  });

  it('rejects format mismatch (e.g. mp3 passed as image)', () => {
    const mp3 = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00]);
    const res = validateMediaPayload(mp3, 'image');
    assert.equal(res.valid, false);
    assert.match(res.error || '', /Format mismatch/);
  });

  it('sanitizes oversized text cleanly', () => {
    const text = 'A'.repeat(500);
    const sanitized = sanitizeTextPayload(text, 100);
    assert.ok(sanitized.length < 500);
    assert.match(sanitized, /characters sanitized to protect context budget/);
  });
});
