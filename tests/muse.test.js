// Meta Model API — the Muse family.
//
// The generic wire behaviour is already swept by providerConformance.test.js,
// which Muse now sits in. This file is only the parts that are NOT generic, and
// every one of them is a place where getting it wrong costs the user money, a
// failed request, or a silently degraded answer:
//
//   * 1.3 is the RECOMMENDED chat model and it cannot hear. Advertising audio
//     on it would send voice into a model Meta itself says answers badly with
//     it — and bill for the tokens.
//   * `"max"` reasoning is Standard tier only. Sending it to a -contributor
//     model is a rejected request mid-agent-loop, which reads to a user as the
//     agent breaking.
//   * The cache discount differs by MODEL, not by vendor: 0.12x on Standard,
//     0.02x on Contributor. One vendor-wide number over-charges a Contributor
//     run six times over on every cached token.
//   * Contributor trades price for permission to train on your prompts. Nothing
//     may quietly move a user onto it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  MuseProvider, MUSE_CHAT_MODELS, MUSE_CONTEXT_TOKENS, MUSE_BASE_URL,
  MUSE_IMAGE_MODEL, MUSE_TRANSCRIBE_MODEL, isContributorModel, clampReasoningEffort
} from '../src/providers/muse.js';
import { createProvider } from '../src/providers/factory.js';
import { TokenTracker } from '../src/tokenTracker.js';
import { PROVIDERS } from '../src/tui/home.js';
import { providerLabel } from '../src/tui/banner.js';

const muse = (model, extra = {}) => new MuseProvider({ apiKey: 'k', model, ...extra });

// The seven ids on the live status page. If Meta renames one, this is where it
// should hurt first.
const LIVE_MODELS = [
  'muse-spark-1.3', 'muse-spark-1.3-contributor',
  'muse-spark-1.2', 'muse-spark-1.2-contributor',
  'muse-spark-1.1', 'muse-image-1.0', 'muse-voice-transcribe-1.0'
];

// ---------------------------------------------------------------------------

describe('the model catalogue matches what Meta actually serves', () => {
  test('every chat model in the catalogue is a real model id', () => {
    for (const entry of MUSE_CHAT_MODELS) {
      assert.ok(LIVE_MODELS.includes(entry.id), `${entry.id} is not on the status page`);
    }
  });

  test('the image and speech models are named, and are not chat models', () => {
    assert.equal(MUSE_IMAGE_MODEL, 'muse-image-1.0');
    assert.equal(MUSE_TRANSCRIBE_MODEL, 'muse-voice-transcribe-1.0');
    const chatIds = MUSE_CHAT_MODELS.map((m) => m.id);
    assert.ok(!chatIds.includes(MUSE_IMAGE_MODEL), 'an image model must never be selected for chat');
    assert.ok(!chatIds.includes(MUSE_TRANSCRIBE_MODEL));
  });

  test('the default is the recommended model', () => {
    assert.equal(muse(undefined).model, 'muse-spark-1.3');
    assert.equal(MUSE_CHAT_MODELS.find((m) => m.recommended).id, 'muse-spark-1.3');
  });

  test('the context window is the published one', () => {
    assert.equal(MUSE_CONTEXT_TOKENS, 1_048_576);
    assert.equal(muse('muse-spark-1.3').contextTokens, 1_048_576);
  });

  test('it talks to the documented base URL', () => {
    assert.equal(MUSE_BASE_URL, 'https://api.meta.ai/v1');
    assert.equal(muse('muse-spark-1.3').baseUrl, 'https://api.meta.ai/v1/chat/completions');
  });
});

describe('what each model can actually do', () => {
  test('every Spark model can see — image, video and PDF are family-wide', () => {
    for (const entry of MUSE_CHAT_MODELS) {
      assert.equal(muse(entry.id).supportsVision, true, `${entry.id} should accept images`);
    }
  });

  test('1.3 cannot hear, and says so — including the contributor variant', () => {
    // Meta: "Audio understanding in Muse Spark 1.3 is currently not fully
    // supported, and response quality for requests including audio content may
    // be degraded." A degraded answer is worse than a refusal, because the user
    // cannot tell it from a correct one.
    assert.equal(muse('muse-spark-1.3').supportsAudio, false);
    assert.equal(muse('muse-spark-1.3-contributor').supportsAudio, false);
  });

  test('1.2 and 1.1 can hear', () => {
    assert.equal(muse('muse-spark-1.2').supportsAudio, true);
    assert.equal(muse('muse-spark-1.2-contributor').supportsAudio, true);
    assert.equal(muse('muse-spark-1.1').supportsAudio, true);
  });

  test('a model that cannot hear names one that can, on the same key', () => {
    assert.equal(muse('muse-spark-1.3').audioAlternative(), 'muse-spark-1.2');
    assert.equal(muse('muse-spark-1.2').audioAlternative(), null, 'no alternative is needed');
  });

  test('and it keeps the tier the user chose', () => {
    // Someone on Contributor is there for the price. Answering "switch to
    // Standard" would quietly multiply their bill by twelve.
    assert.equal(muse('muse-spark-1.3-contributor').audioAlternative(), 'muse-spark-1.2-contributor');
  });

  test('an explicit config override still wins over the catalogue', () => {
    // Meta may fix 1.3's audio before this file is updated; the escape hatch
    // that every other provider has must work here too.
    assert.equal(muse('muse-spark-1.3', { supportsAudio: true }).supportsAudio, true);
  });

  test('no vendor audio ceiling is invented', () => {
    // Meta publishes none. A null means "this vendor adds no limit of its own",
    // and the daemon's authority cap still applies — inventing a number here
    // would reject clips the API would have accepted.
    const p = muse('muse-spark-1.2');
    assert.equal(p.maxAudioBytes, null);
    assert.equal(p.maxAudioSeconds, null);
  });
});

describe('reasoning effort is clamped where the tier will reject it', () => {
  test('max survives on Standard', () => {
    assert.equal(clampReasoningEffort('max', 'muse-spark-1.3'), 'max');
    assert.equal(muse('muse-spark-1.3', { reasoningEffort: 'max' }).reasoningEffort, 'max');
  });

  test('max steps down to high on Contributor, rather than 400ing mid-loop', () => {
    assert.equal(clampReasoningEffort('max', 'muse-spark-1.3-contributor'), 'high');
    assert.equal(muse('muse-spark-1.3-contributor', { reasoningEffort: 'max' }).reasoningEffort, 'high');
  });

  test('every other level passes through untouched, on either tier', () => {
    for (const level of ['low', 'medium', 'high']) {
      assert.equal(clampReasoningEffort(level, 'muse-spark-1.3-contributor'), level);
    }
    assert.equal(clampReasoningEffort('off', 'muse-spark-1.3'), 'off');
    assert.equal(clampReasoningEffort(null, 'muse-spark-1.3'), null);
  });

  test('the contributor test is on the suffix, not on a guessed substring', () => {
    assert.equal(isContributorModel('muse-spark-1.3-contributor'), true);
    assert.equal(isContributorModel('muse-spark-1.3'), false);
    assert.equal(isContributorModel('contributor-something'), false, 'a prefix is not a tier');
  });
});

describe('Muse Voice Transcribe — the answer to 1.3 not hearing', () => {
  const fetchWith = async (impl, fn) => {
    const real = globalThis.fetch;
    globalThis.fetch = impl;
    try { return await fn(); } finally { globalThis.fetch = real; }
  };

  test('it posts to the documented endpoint with the transcription model', async () => {
    let seen = null;
    const text = await fetchWith(async (url, init) => {
      seen = { url, auth: init.headers.Authorization, body: init.body };
      return { ok: true, json: async () => ({ text: 'ship the release' }) };
    }, () => muse('muse-spark-1.3').transcribeAudio('aGVsbG8=', 'audio/wav'));

    assert.equal(text, 'ship the release');
    assert.equal(seen.url, 'https://api.meta.ai/v1/asr/transcribe');
    assert.equal(seen.auth, 'Bearer k', 'the same key as chat — no second credential to configure');
    assert.equal(seen.body.get('model'), MUSE_TRANSCRIBE_MODEL);
    assert.ok(seen.body.get('file'), 'the clip itself must be attached');
  });

  test('it reads the transcript from any of the shapes it might come back in', async () => {
    const cases = [
      [{ text: 'one' }, 'one'],
      [{ transcript: 'two' }, 'two'],
      [{ turns: [{ text: 'three' }, { text: 'four' }] }, 'three four']
    ];
    for (const [payload, expected] of cases) {
      const got = await fetchWith(
        async () => ({ ok: true, json: async () => payload }),
        () => muse('muse-spark-1.3').transcribeAudio('aGVsbG8=')
      );
      assert.equal(got, expected, `failed on ${JSON.stringify(payload)}`);
    }
  });

  test('an empty transcript is null, not an empty user message', async () => {
    const got = await fetchWith(
      async () => ({ ok: true, json: async () => ({ text: '   ' }) }),
      () => muse('muse-spark-1.3').transcribeAudio('aGVsbG8=')
    );
    assert.equal(got, null);
  });

  test('a rejected request throws, so the caller can say WHY rather than go quiet', async () => {
    // The request shape is inferred from Meta's stated OpenAI-SDK compatibility.
    // If that inference is wrong this is the path taken, and the user must land
    // exactly where they would have without the feature — told, not confused.
    await assert.rejects(
      fetchWith(
        async () => ({ ok: false, status: 415, text: async () => 'unsupported media type' }),
        () => muse('muse-spark-1.3').transcribeAudio('aGVsbG8=')
      ),
      /415/
    );
  });

  test('no key and no clip mean no request at all', async () => {
    let called = false;
    await fetchWith(async () => { called = true; return { ok: true, json: async () => ({}) }; }, async () => {
      assert.equal(await muse('muse-spark-1.3').transcribeAudio(''), null);
      assert.equal(await new MuseProvider({ model: 'muse-spark-1.3' }).transcribeAudio('aGVsbG8='), null);
    });
    assert.equal(called, false);
  });

  test('every other provider says "no route" rather than throwing', async () => {
    const { OpenAIProvider } = await import('../src/providers/openai.js');
    assert.equal(await new OpenAIProvider({ apiKey: 'k' }).transcribeAudio('aGVsbG8='), null);
  });
});

describe('cost', () => {
  const tracker = (model) => {
    const t = new TokenTracker();
    t.config = { ...t.config, provider: 'muse', model };
    return t;
  };

  test('the published per-million rates, both tiers', () => {
    assert.deepEqual(tracker('muse-spark-1.3').getPricing(), [1.25, 4.25]);
    assert.deepEqual(tracker('muse-spark-1.3-contributor').getPricing(), [0.10, 0.20]);
  });

  test('the cache discount is per MODEL, not per vendor', () => {
    // $0.15 against $1.25 is 0.12x; $0.002 against $0.10 is 0.02x. Collapsing
    // the two into one vendor number over-charges a Contributor run six times
    // over on every cached token.
    assert.equal(tracker('muse-spark-1.3').cachedInputMultiplier(), 0.12);
    assert.equal(tracker('muse-spark-1.3-contributor').cachedInputMultiplier(), 0.02);
  });

  test('a worked example matches the console arithmetic', () => {
    // 1M input of which 800k cached, plus 100k output, on Standard:
    //   200k × $1.25/1M            = $0.2500
    //   800k × $1.25 × 0.12 /1M    = $0.1200
    //   100k × $4.25/1M            = $0.4250
    const cost = tracker('muse-spark-1.3').calculateCost(1_000_000, 100_000, { cachedPromptTokens: 800_000 });
    assert.ok(Math.abs(cost - 0.795) < 1e-9, `got $${cost}`);
  });

  test('contributor really is the cheap tier, by the advertised order of magnitude', () => {
    const standard = tracker('muse-spark-1.3').calculateCost(1_000_000, 100_000);
    const contributor = tracker('muse-spark-1.3-contributor').calculateCost(1_000_000, 100_000);
    assert.ok(contributor < standard / 10, `${contributor} vs ${standard}: "up to 95% less" should show`);
  });

  test('1.2 and 1.1 fall back to the rate of their own tier, and over-estimate', () => {
    // Meta does not publish 1.2/1.1 rates. Over-estimating is the safe direction
    // for something that stops a run when the budget is spent.
    assert.deepEqual(tracker('muse-spark-1.2').getPricing(), [1.25, 4.25]);
    assert.deepEqual(tracker('muse-spark-1.2-contributor').getPricing(), [0.10, 0.20]);
    assert.deepEqual(tracker('muse-spark-1.1').getPricing(), [1.25, 4.25]);
  });

  test('images are billed per image, and there is no video model to bill for', () => {
    const t = tracker('muse-spark-1.3');
    assert.equal(t.getMediaPricing('muse', MUSE_IMAGE_MODEL, 'image'), 0.01);
    assert.equal(t.getMediaPricing('muse', MUSE_IMAGE_MODEL, 'video_animation'), 0,
      'the family has no video model; a video request must not bill at the image rate');
  });
});

describe('it is reachable the way a user reaches it', () => {
  test('the factory builds it from either name', () => {
    for (const provider of ['muse', 'meta', 'MUSE']) {
      const built = createProvider({ provider, apiKey: 'k', model: 'muse-spark-1.3' });
      assert.ok(built instanceof MuseProvider, `createProvider('${provider}') did not build Muse`);
    }
  });

  test('it appears in the picker with a real default model', () => {
    const entry = PROVIDERS.find((p) => p.id === 'muse');
    assert.ok(entry, 'a provider nobody can select is a provider nobody has');
    assert.ok(LIVE_MODELS.includes(entry.model), `the picker offers ${entry.model}, which is not a live model`);
    assert.ok(!isContributorModel(entry.model),
      "the default must not be the tier that trains on the user prompts — that is opt-in");
  });

  test('it has a name in the session header', () => {
    assert.equal(providerLabel('muse'), 'Meta');
    assert.equal(providerLabel('meta'), 'Meta');
  });
});
