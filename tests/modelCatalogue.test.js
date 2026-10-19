import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MODEL_CATALOGUE, PROVIDER_LABELS, DEFAULT_MODEL_BY_PROVIDER, allCatalogueModels } from '../src/modelCatalogue.js';
import { canonicalModelId } from '../src/modelIds.js';
import { PROVIDERS } from '../src/tui/home.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
function anthropicCapabilityIds() {
  const source = fs.readFileSync(path.join(HERE, '..', 'src', 'providers', 'anthropic.js'), 'utf8');
  const ids = new Set();
  for (const listName of ['TOOL_SEARCH_MODELS', 'NO_SAMPLING_MODELS', 'ADAPTIVE_THINKING_MODELS', 'MID_CONVERSATION_SYSTEM_MODELS']) {
    const block = source.match(new RegExp(`const ${listName} = \\[([\\s\\S]*?)\\];`));
    if (!block) continue;
    for (const m of block[1].matchAll(/'([^']+)'/g)) ids.add(m[1]);
  }
  return ids;
}

test('model catalogue: every id is already canonical', () => {
  for (const id of allCatalogueModels()) {
    assert.equal(
      canonicalModelId(id), id,
      `${id} is not canonical — canonicalModelId() rewrites it to ${canonicalModelId(id)}`
    );
  }
});

test('model catalogue: every Anthropic id is known to the daemon capability lists', () => {
  // This is the regression that shipped: `claude-opus-4.8` matched NOTHING, so
  // adaptive thinking and deferred tool loading were silently off and
  // `temperature` went to a model that rejects it with a 400. anthropic.js
  // matches with startsWith, so mirror that exactly.
  const known = anthropicCapabilityIds();
  assert.ok(known.size > 0, 'failed to read any capability list out of anthropic.js');

  for (const id of MODEL_CATALOGUE['Anthropic']) {
    const lowered = id.toLowerCase();
    const hit = [...known].some(supported => lowered.startsWith(supported));
    assert.ok(hit, `${id} matches no capability list in providers/anthropic.js`);
  }
});

test('model catalogue: every provider default is a model the catalogue offers', () => {
  const offered = new Set(allCatalogueModels());
  for (const [provider, model] of Object.entries(DEFAULT_MODEL_BY_PROVIDER)) {
    if (model === '') continue; // openai-compatible takes a user-supplied id
    assert.ok(offered.has(model), `default for ${provider} (${model}) is not in MODEL_CATALOGUE`);
  }
});

test('model catalogue: the terminal home screen derives its defaults from it', () => {
  for (const entry of PROVIDERS) {
    assert.equal(
      entry.model, DEFAULT_MODEL_BY_PROVIDER[entry.id] ?? '',
      `home.js PROVIDERS suggests ${entry.model} for ${entry.id}; the catalogue says ${DEFAULT_MODEL_BY_PROVIDER[entry.id]}`
    );
  }
});

test('providers: every constructor normalises the model id', async () => {
  // REGRESSION GUARD. Normalising in LLMProvider's constructor was not enough:
  // every subclass re-assigned `this.model = config.model || '<default>'`
  // immediately after super(), silently undoing it. The fix only became real
  // once each subclass normalised too, so assert the behaviour at the class
  // that actually builds the payload — not at the base.
  const { createProvider } = await import('../src/providers/factory.js').catch(() => ({}));
  const modules = {
    anthropic: 'anthropic.js', openai: 'openai.js', gemini: 'gemini.js',
    deepseek: 'deepseek.js', moonshot: 'moonshot.js', xai: 'xai.js',
    muse: 'muse.js', ollama: 'ollama.js'
  };

  for (const file of Object.values(modules)) {
    const mod = await import(`../src/providers/${file}`);
    const Provider = Object.values(mod).find(v => typeof v === 'function' && /Provider$/.test(v.name));
    if (!Provider) continue;

    const instance = new Provider({ apiKey: 'test', model: 'claude-opus-4.8' });
    assert.equal(
      instance.model, 'claude-opus-4-8',
      `${file} does not normalise the model id — a dotted id reaches the request payload`
    );
  }
  assert.ok(createProvider === undefined || typeof createProvider === 'function');
});

test('providers: every constructor default comes from the catalogue', async () => {
  // These fallbacks were a sixth hand-maintained copy of the model list, and
  // two had rotted to 2024 ids (`gpt-4o`, `gemini-1.5-pro-latest`).
  const cases = [
    ['openai.js', DEFAULT_MODEL_BY_PROVIDER.openai],
    ['gemini.js', DEFAULT_MODEL_BY_PROVIDER.gemini],
    ['anthropic.js', DEFAULT_MODEL_BY_PROVIDER.anthropic],
    ['moonshot.js', DEFAULT_MODEL_BY_PROVIDER.moonshot],
    ['xai.js', DEFAULT_MODEL_BY_PROVIDER.xai],
    ['deepseek.js', DEFAULT_MODEL_BY_PROVIDER.deepseek]
  ];

  for (const [file, expected] of cases) {
    const mod = await import(`../src/providers/${file}`);
    const Provider = Object.values(mod).find(v => typeof v === 'function' && /Provider$/.test(v.name));
    const instance = new Provider({ apiKey: 'test' }); // no model supplied
    assert.equal(instance.model, expected, `${file} falls back to ${instance.model}, catalogue says ${expected}`);
  }
});






