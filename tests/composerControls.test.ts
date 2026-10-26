import { test } from 'node:test';
import assert from 'node:assert/strict';

import { availableModelVariants } from '../src/tui/composerControls.js';
import { ChatPrompt } from '../src/tui/prompt.js';

test('variant choices follow the active provider catalogue', () => {
  const variants = availableModelVariants({ provider: 'antigravity', model: 'Gemini 3.8 Flash (High)' });
  assert.deepEqual(variants, [
    'Gemini 3.8 Flash (Low)',
    'Gemini 3.8 Flash (Medium)',
    'Gemini 3.8 Flash (High)'
  ]);
  assert.deepEqual(availableModelVariants({ provider: 'acp/cursor', model: 'cursor' }), []);
});

test('composer shortcuts open controls without modifying the draft', async () => {
  const opened: string[] = [];
  const out = { columns: 120, rows: 40, write: () => true };
  const input = { isTTY: true };
  const prompt = new ChatPrompt({
    out,
    input,
    onOpenMode: () => { opened.push('mode'); },
    onOpenModel: () => { opened.push('model'); },
    onOpenVariant: () => { opened.push('variant'); }
  });
  prompt.editor.setText('preserve this draft');
  prompt.handleKey({ name: 'g', ctrl: true });
  prompt.handleKey({ name: 'm', alt: true });
  prompt.handleKey({ name: 't', ctrl: true });
  await Promise.resolve();
  assert.deepEqual(opened, ['mode', 'model', 'variant']);
  assert.equal(prompt.editor.getText(), 'preserve this draft');
});
