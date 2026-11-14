import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectInlineSlashTrigger, removeInlineSlashToken } from '../src/tui/inlineSlash.js';

describe('inlineSlash cursor normalization', () => {
  it('truncates fractional cursor consistently with removeInlineSlashToken', () => {
    const text = ' /help ';
    const trigger = detectInlineSlashTrigger(text, 6.5);
    assert.ok(trigger);
    assert.equal(Number.isInteger(trigger.start), true);
    assert.equal(Number.isInteger(trigger.tokenStart), true);
    const removed = removeInlineSlashToken(text, 6.5, trigger);
    assert.equal(removed.text, '  ');
  });
});
