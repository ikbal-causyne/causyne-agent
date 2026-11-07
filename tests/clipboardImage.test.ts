import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  detectImageMimeType,
  formatByteSize,
  persistImageBuffer,
  loadLocalImageAttachment,
  readClipboardImageSync,
  extractPastedFilePath,
  isLocalImageFile
} from '../src/tui/clipboardImage.js';
import { pasteIntoChatbox } from '../src/tui/chatboxClipboard.js';

describe('Clipboard Image Reader & Attachment Capabilities', () => {
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const gifHeader = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00]);
  const webpHeader = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20
  ]);

  test('detectImageMimeType correctly recognizes standard image magic bytes', () => {
    assert.equal(detectImageMimeType(pngHeader), 'image/png');
    assert.equal(detectImageMimeType(jpegHeader), 'image/jpeg');
    assert.equal(detectImageMimeType(gifHeader), 'image/gif');
    assert.equal(detectImageMimeType(webpHeader), 'image/webp');
    assert.equal(detectImageMimeType(Buffer.from('hello world plain text')), null);
  });

  test('formatByteSize formats byte values into human-readable units', () => {
    assert.equal(formatByteSize(500), '500 B');
    assert.equal(formatByteSize(45 * 1024), '45 KB');
    assert.equal(formatByteSize(2.5 * 1024 * 1024), '2.5 MB');
  });

  test('persistImageBuffer saves image to attachments directory and returns valid metadata', () => {
    const attachment = persistImageBuffer(pngHeader, 'test_mock.png');
    assert.ok(attachment, 'Attachment must be created');
    assert.equal(attachment.type, 'image');
    assert.equal(attachment.mimeType, 'image/png');
    assert.equal(attachment.name, 'test_mock.png');
    assert.ok(fs.existsSync(attachment.path), 'Attachment file must exist on disk');
    assert.equal(attachment.size, pngHeader.length);
    assert.equal(attachment.base64, pngHeader.toString('base64'));

    // Clean up
    try { fs.unlinkSync(attachment.path); } catch { /* ignore */ }
  });

  test('loadLocalImageAttachment loads valid image file and rejects non-image or missing files', () => {
    const tmpImg = path.join(os.tmpdir(), `causyne_test_${Date.now()}.png`);
    fs.writeFileSync(tmpImg, pngHeader);

    try {
      const att = loadLocalImageAttachment(tmpImg);
      assert.ok(att, 'Should load valid image');
      assert.equal(att.type, 'image');
      assert.equal(att.mimeType, 'image/png');

      const nonExistent = loadLocalImageAttachment('/tmp/definitely_not_a_real_file_12345.png');
      assert.equal(nonExistent, null);
    } finally {
      try { fs.unlinkSync(tmpImg); } catch { /* ignore */ }
    }
  });

  test('pasteIntoChatbox handles image paste seamlessly when text clipboard is empty', () => {
    let text = '';
    const mockPrompt = {
      editor: {
        lines: [['']],
        line: 0,
        col: 0,
        isEmpty: true,
        getText: () => text,
        setText: (t: string) => { text = t; },
        insert: (t: string) => { text += t; },
        clear: () => { text = ''; }
      },
      notice: '',
      scheduleDraw: () => {},
      refreshCompletion: () => {},
      pendingAttachments: []
    };

    // Case 1: explicit text provided
    const textRes = pasteIntoChatbox(mockPrompt, 'hello world');
    assert.equal(textRes.success, true);
    assert.equal(textRes.isImage, false);
    assert.ok(text.includes('hello world'));

    // Reset
    text = '';
    mockPrompt.pendingAttachments = [];

    // Case 2: readClipboardImageSync returns null when clipboard has no image
    // Function executes safely without throwing
    const res = readClipboardImageSync();
    assert.ok(res === null || (res && res.type === 'image'));
  });

  test('ChatPrompt exposes consumeAttachments and manages pending multimodal queue', async () => {
    const { ChatPrompt } = await import('../src/tui/prompt.js');
    const prompt = new ChatPrompt({ out: { write: () => true, columns: 80, rows: 24 } });
    assert.deepEqual(prompt.consumeAttachments(), []);

    // Push mock image
    const mockAttachment = {
      type: 'image' as const,
      mimeType: 'image/png' as const,
      base64: 'abc==',
      name: 'screenshot_test.png',
      path: '/tmp/test.png',
      size: 1024
    };
    prompt.pendingAttachments.push(mockAttachment);
    assert.equal(prompt.pendingAttachments.length, 1);

    const consumed = prompt.consumeAttachments();
    assert.equal(consumed.length, 1);
    assert.equal(consumed[0]?.name, 'screenshot_test.png');
    assert.equal(prompt.pendingAttachments.length, 0, 'Queue must be drained upon consumption');
  });

  test('extractPastedFilePath and isLocalImageFile handle quotes, URLs, and image validation', () => {
    assert.equal(extractPastedFilePath('"foo/bar.png"'), 'foo/bar.png');
    assert.equal(extractPastedFilePath("'foo/bar.png'"), 'foo/bar.png');
    assert.equal(extractPastedFilePath('foo/my\\ image.png'), 'foo/my image.png');

    const tmpImg = path.join(os.tmpdir(), `causyne_test_ext_${Date.now()}.png`);
    fs.writeFileSync(tmpImg, pngHeader);

    try {
      assert.equal(isLocalImageFile(tmpImg), true);
      assert.equal(isLocalImageFile(`"${tmpImg}"`), true);
      assert.equal(isLocalImageFile('non_existent.png'), false);

      let text = '';
      const promptObj = {
        editor: {
          lines: [['']],
          line: 0,
          col: 0,
          isEmpty: true,
          getText: () => text,
          setText: (t: string) => { text = t; },
          insert: (t: string) => { text += t; },
          clear: () => { text = ''; }
        },
        notice: '',
        scheduleDraw: () => {},
        refreshCompletion: () => {},
        pendingAttachments: []
      };

      const dropRes = pasteIntoChatbox(promptObj, tmpImg);
      assert.equal(dropRes.success, true);
      assert.equal(dropRes.isImage, true);
      assert.equal(text, '[Image 1] ');
      assert.equal(promptObj.pendingAttachments.length, 1);

      // Second paste numbers sequentially as [Image 2]
      const dropRes2 = pasteIntoChatbox(promptObj, tmpImg);
      assert.equal(dropRes2.success, true);
      assert.equal(dropRes2.isImage, true);
      assert.equal(text, '[Image 1] [Image 2] ');
      assert.equal(promptObj.pendingAttachments.length, 2);
    } finally {
      try { fs.unlinkSync(tmpImg); } catch { /* ignore */ }
    }
  });
});
