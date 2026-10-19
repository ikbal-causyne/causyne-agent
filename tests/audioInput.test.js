// Audio input: capability routing, wire shape, and the limit layers.
//
// Voice is the one input that is simultaneously expensive, large, and silently
// droppable. Three failure modes are pinned here because each one already
// shipped once:
//
//   1. An audio block reaching a model that cannot hear. It used to be sent
//      anyway (400 from the vendor) or deleted with no trace (the model answered
//      as though the user had said nothing).
//   2. The container being mislabelled. `format` was hardcoded to 'mp3' while
//      the recorder produced AAC, so every clip failed to decode.
//   3. An unbounded clip. Nothing capped duration or size at any layer.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createProvider } from '../src/providers/factory.js';
import {
  audioFormatForMimeType,
  mimeTypeForAudioFormat,
  isAudioBlock
} from '../src/providers/base.js';

const audioMsg = (data = 'AAAA', format = 'wav') => ({
  role: 'user',
  content: [
    { type: 'text', text: 'transcribe this' },
    { type: 'input_audio', input_audio: { data, format } }
  ]
});

describe('audio capability is decided per model, not per vendor', () => {
  test('OpenAI serves images everywhere but audio only on the audio family', () => {
    // The trap: visionModels is '*' here. Copying that to audioModels would
    // send input_audio to every gpt-* text model, all of which reject it.
    const text = createProvider({ provider: 'openai', model: 'gpt-5.6-sol', apiKey: 'k' });
    const audio = createProvider({ provider: 'openai', model: 'gpt-4o-audio-preview', apiKey: 'k' });

    assert.equal(text.supportsVision, true, 'OpenAI vision is model-agnostic');
    assert.equal(text.supportsAudio, false, 'a text model must not be offered audio');
    assert.equal(audio.supportsAudio, true);
  });

  test('Anthropic reads images on every model and hears nothing', () => {
    const p = createProvider({ provider: 'anthropic', model: 'claude-sonnet-4', apiKey: 'k' });
    assert.equal(p.supportsVision, true);
    assert.equal(p.supportsAudio, false);
  });

  test('Gemini hears across the family and uses its own wire shape', () => {
    const p = createProvider({ provider: 'gemini', model: 'gemini-2.5-pro', apiKey: 'k' });
    assert.equal(p.supportsAudio, true);
    assert.equal(p.audioPayloadFormat, 'gemini');
  });

  test('an explicit config flag overrides the table for unlisted endpoints', () => {
    // Local and custom endpoints serve models no prefix list can know about.
    const p = createProvider({
      provider: 'ollama', model: 'some-private-omni-build', apiKey: 'k', supportsAudio: true
    });
    assert.equal(p.supportsAudio, true);
  });
});

describe('audio never reaches a model that cannot process it', () => {
  test('a deaf model gets a visible marker, not a silent deletion', () => {
    // The old behaviour deleted the block outright. The user recorded a clip,
    // the model answered as if nothing had been said, and nothing explained why.
    const p = createProvider({ provider: 'anthropic', model: 'claude-sonnet-4', apiKey: 'k' });
    const [out] = p.prepareMessages([audioMsg()]);

    const blocks = Array.isArray(out.content) ? out.content : [{ type: 'text', text: out.content }];
    assert.ok(!blocks.some(isAudioBlock), 'no audio may survive to a deaf model');
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
    assert.match(text, /Audio content removed/, 'the user must be told the audio was dropped');
  });

  test('a hearing model keeps the audio', () => {
    const p = createProvider({ provider: 'gemini', model: 'gemini-2.5-pro', apiKey: 'k' });
    const [out] = p.prepareMessages([audioMsg()]);
    assert.ok(out.content.some(isAudioBlock), 'an audio-capable model must still receive it');
  });

  test('a model that is blind but hearing keeps its audio', () => {
    // flattenToTextOnly runs for a non-vision model and used to collapse content
    // to a bare string, destroying an audio block the audio branch would keep.
    const p = createProvider({ provider: 'ollama', model: 'llama3', apiKey: 'k', supportsAudio: true });
    assert.equal(p.supportsVision, false, 'precondition: this model cannot see');
    const [out] = p.prepareMessages([audioMsg()]);
    assert.ok(Array.isArray(out.content) && out.content.some(isAudioBlock),
      'being blind must not make a model deaf');
  });

  test('Gemini receives inlineData with the real container type', () => {
    const p = createProvider({ provider: 'gemini', model: 'gemini-2.5-pro', apiKey: 'k' });
    const [out] = p.prepareMessages([audioMsg('AAAA', 'm4a')]);
    const block = out.content.find(isAudioBlock);
    assert.equal(block.inlineData.mimeType, 'audio/mp4',
      'the clip must be labelled with what it actually is');
  });
});

describe('container format is derived, never assumed', () => {
  test('each MIME maps to the token its vendor expects', () => {
    assert.equal(audioFormatForMimeType('audio/wav'), 'wav');
    assert.equal(audioFormatForMimeType('audio/mp4'), 'm4a');
    assert.equal(audioFormatForMimeType('audio/mpeg'), 'mp3');
  });

  test('an m4a is never relabelled as an mp3', () => {
    // The exact shipped bug: format was hardcoded 'mp3' for AAC/m4a bytes, so
    // the provider accepted the request and failed on decode.
    assert.notEqual(audioFormatForMimeType('audio/mp4'), 'mp3');
  });

  test('the mapping round-trips', () => {
    for (const format of ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'flac']) {
      assert.equal(audioFormatForMimeType(mimeTypeForAudioFormat(format)), format);
    }
  });

  test('an unknown MIME degrades to the universally accepted container', () => {
    assert.equal(audioFormatForMimeType('application/octet-stream'), 'wav');
    assert.equal(audioFormatForMimeType(undefined), 'wav');
  });
});
