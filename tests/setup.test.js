import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSetup, validateEndpoint } from '../src/tui/setup.js';
import { configureInPrompt } from '../src/tui/home.js';
import { SelectLayer } from '../src/tui/dialogs.js';
const providers = [
  { id: 'openai', label: 'OpenAI', hint: '', model: 'model-a' },
  { id: 'anthropic', label: 'Anthropic', hint: '', model: 'model-b' },
  { id: 'ollama', label: 'Ollama', hint: '', model: 'local' },
  { id: 'openai-compatible', label: 'Custom', hint: '', model: 'custom' }
];
function harness(choices, texts, initial = {}) {
  const questions = []; const saved = [];
  const store = { loadConfig: () => structuredClone(initial), saveConfig: config => saved.push(config) };
  const ui = {
    async select(q) { questions.push(q); const id = choices.shift(); return q.items.find(i => i.id === id) || null; },
    async text(q) { questions.push(q); return texts.shift() ?? null; }
  };
  return { ui, store, questions, saved, run: () => runSetup(ui, providers, store, '/workspace') };
}
test('provider change cannot inherit a credential or old endpoint', async () => {
  const h = harness(['anthropic', 'B', 'save'], ['model-b', 'new-key'],
    { provider: 'openai', apiKey: 'old-key', baseUrl: 'https://old.test/chat', tokenBudget: { maxCostUsd: 3 } });
  await h.run();
  assert.equal(h.saved[0].apiKey, 'new-key');
  assert.equal(h.saved[0].baseUrl, undefined);
  assert.deepEqual(h.saved[0].tokenBudget, { maxCostUsd: 3 });
  assert.ok(!JSON.stringify(h.questions).includes('old-key'));
  assert.ok(!JSON.stringify(h.questions).includes('new-key'));
});
test('same provider keeps its key while changed custom endpoint drops it', async () => {
  const same = harness(['openai', 'B', 'save'], ['model-a', ''], { provider: 'openai', apiKey: 'old-key' });
  await same.run(); assert.equal(same.saved[0].apiKey, 'old-key');
  const moved = harness(['openai-compatible', 'B', 'save'], ['https://new.test/chat', 'custom', ''],
    { provider: 'openai-compatible', baseUrl: 'https://old.test/chat', apiKey: 'old-key' });
  await moved.run(); assert.equal(moved.saved[0].apiKey, '');
});
test('Ollama skips credentials and review cancellation writes nothing', async () => {
  const h = harness(['ollama', 'C', 'cancel'], ['http://localhost:11434/api/chat', 'local'], { provider: 'openai', apiKey: 'old' });
  assert.equal(await h.run(), null); assert.equal(h.saved.length, 0);
  assert.ok(!h.questions.some(q => q.mask));
});
test('cancel at every setup stage leaves config unchanged', async () => {
  for (const [choices, texts] of [
    [[], []], [['openai-compatible'], []], [['openai'], []], [['openai'], ['model']],
    [['openai'], ['model', 'key']], [['openai', 'B'], ['model', 'key']]
  ]) {
    const h = harness(choices, texts); assert.equal(await h.run(), null); assert.equal(h.saved.length, 0);
  }
});
test('empty credential on a different hosted provider re-prompts rather than copying', async () => {
  const h = harness(['anthropic', 'B', 'save'], ['model', '', 'new'], { provider: 'openai', apiKey: 'old' });
  await h.run(); assert.equal(h.saved[0].apiKey, 'new');
  assert.equal(h.questions.filter(q => q.mask).length, 2);
});
test('endpoint validator rejects credential leaks and insecure external HTTP', () => {
  const credentialURL = new URL('https://example.invalid/chat');
  credentialURL.username = 'fixture'; credentialURL.password = 'not-a-secret';
  assert.ok(validateEndpoint(credentialURL.href));
  for (const url of ['file:///tmp', 'http://example.com/chat', 'https://test/chat?key=secret', 'https://test/#secret']) assert.ok(validateEndpoint(url));
  for (const url of ['https://example.com/chat', 'http://localhost:11434/api/chat', 'http://[::1]:11434/api/chat']) assert.equal(validateEndpoint(url), null);
});
test('dismissed provider picker resolves in-chat setup instead of hanging', async () => {
  let layer; let saves = 0;
  const result = configureInPrompt({ openLayer(value) { layer = value; } }, { loadConfig: () => ({}), saveConfig() { saves++; } });
  assert.ok(layer instanceof SelectLayer);
  layer.answer();
  assert.equal(await result, null); assert.equal(saves, 0);
});
test('picker selection followed by dismissal does not deliver duplicate answers', () => {
  const answers = [];
  const layer = new SelectLayer({ items: [{ id: 'one', label: 'one' }], onPick: item => answers.push(item) });
  layer.key({ name: 'enter' }); layer.answer();
  assert.equal(answers.length, 1); assert.equal(answers[0].id, 'one');
});

test('setup runs through actual prompt keyboard routing without losing steps', async () => {
  const { EventEmitter } = await import('node:events');
  const { ChatPrompt } = await import('../src/tui/prompt.js');
  const out = new EventEmitter(); out.columns = 90; out.rows = 30; out.isTTY = true;
  let rendered = ''; out.write = text => { rendered += text; };
  const input = new EventEmitter(); input.isTTY = true; input.setRawMode = () => {}; input.resume = () => {}; input.pause = () => {};
  const prompt = new ChatPrompt({ out, input, commands: [] });
  const saved = [];
  prompt.start();
  try {
    const result = configureInPrompt(prompt, { loadConfig: () => ({provider:'deepseek',model:'test',apiKey:'old'}), saveConfig: c => saved.push(c) });
    const enter = async () => { input.emit('data', Buffer.from('\r')); await new Promise(resolve => setImmediate(resolve)); };
    await enter(); // provider
    await enter(); // model
    input.emit('data',Buffer.from('fake-test-key')); await enter(); // masked key
    await enter(); // Mode B
    await enter(); // review save
    assert.ok(await result);
    assert.equal(saved[0].apiKey, 'fake-test-key');
    assert.ok(!rendered.includes('fake-test-key'));
    assert.equal(prompt.layer, null);
  } finally { prompt.stop(); }
});
