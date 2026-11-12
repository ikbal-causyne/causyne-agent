import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatPrompt } from '../src/tui/prompt.js';

function harness() {
  const output = [];
  const rendered = [];
  const prompt = new ChatPrompt({
    out: { columns: 100, rows: 32, write(s) { output.push(s); return true; }, on() {}, removeListener() {} },
    renderer: { renderUserMessage(s) { rendered.push(s); } },
    isCommand: (text) => /^\//.test(text)
  });
  return { prompt, output, rendered };
}

test('non-busy submit without a read waiter is not silently discarded', async () => {
  const { prompt, rendered } = harness();
  prompt.editor.setText('sent between two turns');
  prompt.submit();
  assert.equal(prompt.editor.getText(), '');
  assert.equal(prompt.queue.length, 1);
  assert.deepEqual(rendered, [], 'unsent text must not appear as a completed submission');
  assert.equal(await prompt.read(), 'sent between two turns');
  assert.deepEqual(rendered, ['sent between two turns']);
});

test('messages entered during a running turn are retained and dispatched FIFO', async () => {
  const { prompt, rendered } = harness();
  prompt.setBusy(true);
  prompt.editor.setText('first');
  prompt.submit();
  prompt.editor.setText('second');
  prompt.submit();
  assert.equal(prompt.queue.length, 2);
  assert.deepEqual(rendered, []);
  assert.match(prompt.queuedPreviewRows(100).join(''), /Queued \(2\).*second/);
  prompt.setBusy(false);
  assert.equal(await prompt.read(), 'first');
  assert.equal(await prompt.read(), 'second');
  assert.deepEqual(rendered, ['first', 'second']);
  assert.equal(prompt.queue.length, 0);
  assert.deepEqual(prompt.queuedPreviewRows(100), []);
});

test('each queued message receives only its own pasted image attachments', async () => {
  const { prompt } = harness();
  prompt.setBusy(true);
  const firstImage = { id: 'first-image' };
  const secondImage = { id: 'second-image' };
  prompt.pendingAttachments.push(firstImage);
  prompt.editor.setText('[Image 1] first request');
  prompt.submit();
  prompt.pendingAttachments.push(secondImage);
  prompt.editor.setText('[Image 1] second request');
  prompt.submit();
  prompt.setBusy(false);
  assert.equal(await prompt.read(), '[Image 1] first request');
  assert.deepEqual(prompt.consumeAttachments(), [firstImage]);
  assert.equal(await prompt.read(), '[Image 1] second request');
  assert.deepEqual(prompt.consumeAttachments(), [secondImage]);
  assert.deepEqual(prompt.consumeAttachments(), []);
});

test('images pasted during the next draft cannot leak into an already submitted turn', async () => {
  const { prompt } = harness();
  const old = { id: 'old' };
  const future = { id: 'future' };
  const waiting = prompt.read();
  prompt.pendingAttachments.push(old);
  prompt.editor.setText('initial task');
  prompt.submit();
  assert.equal(await waiting, 'initial task');
  prompt.pendingAttachments.push(future);
  assert.deepEqual(prompt.consumeAttachments(), [old]);
  prompt.editor.setText('future task');
  prompt.submit();
  assert.equal(await prompt.read(), 'future task');
  assert.deepEqual(prompt.consumeAttachments(), [future]);
});

test('queued slash commands remain commands and do not consume draft attachments', async () => {
  const { prompt, rendered } = harness();
  prompt.pendingAttachments.push({ id: 'image-after-command' });
  prompt.editor.setText('/help');
  prompt.submit();
  assert.equal(await prompt.read(), '/help');
  assert.deepEqual(rendered, []);
  prompt.editor.setText('request after help');
  prompt.submit();
  assert.equal(await prompt.read(), 'request after help');
  assert.deepEqual(prompt.consumeAttachments(), [{ id: 'image-after-command' }]);
});

test('full queue preserves input and attachments even in the no-waiter gap', () => {
  const { prompt } = harness();
  prompt.queue = Array.from({ length: 32 }, (_, i) => 'queued ' + i);
  prompt.pendingAttachments.push({ id: 'not-lost' });
  prompt.editor.setText('please keep this draft');
  prompt.submit();
  assert.equal(prompt.queue.length, 32);
  assert.equal(prompt.editor.getText(), 'please keep this draft');
  assert.deepEqual(prompt.pendingAttachments, [{ id: 'not-lost' }]);
  assert.match(prompt.notice, /32 queued/);
});

test('queued preview bounds rendered text before large submissions are formatted', () => {
  const { prompt } = harness();
  prompt.editor.setText('X'.repeat(200_000));
  prompt.submit();
  const row = prompt.queuedPreviewRows(55)[0];
  assert.match(row, /Queued/);
  assert.ok(row.length < 100, 'a queue preview must be bounded by terminal width');
});
