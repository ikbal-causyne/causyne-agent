import test from 'node:test';
import assert from 'node:assert/strict';

import { geminiUsageToOpenAIShape, GeminiProvider } from '../src/providers/gemini.js';
import { TokenTracker } from '../src/tokenTracker.js';

const provider = () => new GeminiProvider({ apiKey: 'test', model: 'gemini-3.5-flash' });
const normalise = (metadata) => provider().normalizeUsage(geminiUsageToOpenAIShape(metadata));

test('gemini usage: cached tokens reach the cost model', () => {
  // THE BUG: gemini.js built its usage object by hand and never called
  // normalizeUsage(), so cachedContentTokenCount was dropped. calculateCost()
  // was always cache-aware — it was fed a zero, and every cached token was
  // displayed at the full input rate.
  const usage = normalise({
    promptTokenCount: 7000,
    candidatesTokenCount: 100,
    totalTokenCount: 7100,
    cachedContentTokenCount: 6000
  });

  assert.equal(usage.promptTokens, 7000);
  assert.equal(usage.cachedPromptTokens, 6000, 'cached tokens must survive into the cost model');
});

test('gemini usage: thinking tokens are billed, under either backend convention', () => {
  // thoughtsTokenCount is folded into candidatesTokenCount on the Gemini API
  // and is NOT on Vertex AI. Deriving completion from totalTokenCount is
  // correct under both; summing candidates+thoughts is correct under only one.
  const geminiApi = normalise({
    promptTokenCount: 1000, candidatesTokenCount: 500,
    thoughtsTokenCount: 300, totalTokenCount: 1500
  });
  const vertex = normalise({
    promptTokenCount: 1000, candidatesTokenCount: 200,
    thoughtsTokenCount: 300, totalTokenCount: 1500
  });

  assert.equal(geminiApi.completionTokens, 500, 'thoughts already inside candidates must not be double-counted');
  assert.equal(vertex.completionTokens, 500, 'thoughts outside candidates must still be billed');
});

test('gemini usage: falls back to candidates + thoughts when no total is reported', () => {
  const usage = normalise({ promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 300 });
  assert.equal(usage.completionTokens, 500);
});

test('gemini usage: an absent or empty usage block yields zeros, never NaN', () => {
  for (const metadata of [undefined, null, {}]) {
    const usage = normalise(metadata);
    assert.equal(usage.promptTokens, 0);
    assert.equal(usage.completionTokens, 0);
    assert.equal(usage.cachedPromptTokens, 0);
  }
});

test('gemini usage: a cache hit actually lowers the displayed cost', () => {
  // The whole point of B3, asserted end to end rather than at the field level.
  const tracker = new TokenTracker();
  tracker.config = { ...tracker.config, provider: 'gemini', model: 'gemini-3.5-flash' };

  const metadata = { promptTokenCount: 7000, candidatesTokenCount: 100, totalTokenCount: 7100 };
  const uncached = normalise(metadata);
  const cached = normalise({ ...metadata, cachedContentTokenCount: 6000 });

  const costUncached = tracker.calculateCost(uncached.promptTokens, uncached.completionTokens, uncached);
  const costCached = tracker.calculateCost(cached.promptTokens, cached.completionTokens, cached);

  assert.ok(
    costCached < costUncached,
    `a cached turn must cost less than an uncached one (cached ${costCached}, uncached ${costUncached})`
  );
});
