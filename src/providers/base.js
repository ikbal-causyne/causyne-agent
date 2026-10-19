import { canonicalModelId } from '../modelIds.js';

// Fields the agent loop attaches to messages for its own bookkeeping. They must
// never reach a provider API, which rejects unknown message properties.
const INTERNAL_MESSAGE_FIELDS = ['cacheAnchor', 'spillPath'];

// Container formats each vendor actually accepts for audio input. Kept here so

// instead of three drifting copies.
const AUDIO_MIME_BY_FORMAT = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  webm: 'audio/webm'
};

/** Map a container format token to the MIME type a provider expects. */
export function mimeTypeForAudioFormat(format) {
  return AUDIO_MIME_BY_FORMAT[String(format || '').toLowerCase()] || 'audio/wav';
}

/**
 * Map a MIME type to the short format token OpenAI's input_audio wants.
 *
 * OpenAI accepts only 'wav' and 'mp3'. Anything else is reported honestly as
 * itself so the provider layer can reject it with a clear message rather than
 * mislabelling an m4a as an mp3 and letting the vendor fail on decode — which
 * is exactly what the previous hardcoded format:'mp3' did.
 */
export function audioFormatForMimeType(mimeType) {
  const mime = String(mimeType || '').toLowerCase().split(';')[0].trim();
  for (const [format, candidate] of Object.entries(AUDIO_MIME_BY_FORMAT)) {
    if (candidate === mime) return format;
  }
  if (mime === 'audio/mp3') return 'mp3';
  if (mime === 'audio/x-wav' || mime === 'audio/wave') return 'wav';
  if (mime === 'audio/x-m4a') return 'm4a';
  return 'wav';
}

/** True for an audio content block in either the OpenAI or the Gemini shape. */
export function isAudioBlock(block) {
  if (!block) return false;
  if (block.type === 'input_audio') return true;
  return Boolean(block.inlineData && String(block.inlineData.mimeType || '').startsWith('audio/'));
}

export class LLMProvider {
  constructor(config) {
    this.apiKey = config.apiKey;
    // Normalised here rather than at each caller: this is the last hop before
    // the request payload and every provider extends this class, so a bad id
    
    // written before this existed) is corrected exactly once. A dotted
    // Anthropic id used to match none of anthropic.js's capability lists,
    // which silently disabled thinking and tool search and sent `temperature`
    // to models that reject it. See src/modelIds.js.
    this.model = canonicalModelId(config.model);
    this.baseUrl = config.baseUrl; // For openai-compatible endpoints

    // Model-id prefixes this provider can send images to. Vision is a property
    // of the *model*, not the vendor, so each provider declares its own list —
    // the same pattern AnthropicProvider uses for tool search. A single '*'
    // means every model this provider serves accepts images.
    //
    // This replaced a flat `supportsVision = false` on the base class that only
    // OpenAI and Anthropic ever overrode, which silently culled `screenshot`
    // and `vision_inspect_ui` from the catalogue on seven of ten providers and
    // made the mandatory visual-verification step of the anti-slop directive
    // impossible to satisfy on any of them.
    this.visionModels = [];

    
    this.imagePayloadFormat = 'openai';

    // An explicit config value always wins. Custom OpenAI-compatible endpoints
    // serve models this list cannot possibly know about.
    this.visionOverride = typeof config.supportsVision === 'boolean'
      ? config.supportsVision
      : null;

    // Model-id prefixes this provider can send AUDIO to. Same shape and same
    // reasoning as visionModels above — audio is a property of the model, not
    // the vendor. It is deliberately NOT derived from visionModels: the two
    // capabilities diverge sharply. OpenAI serves images on every model but
    // accepts input_audio only on the gpt-4o-audio / gpt-audio family, and
    // Anthropic reads images on every model while accepting no audio at all.
    // Defaulting audio to the vision list would 400 on both.
    this.audioModels = [];

    
    this.audioPayloadFormat = 'openai';

    // Hard ceiling on a single audio clip for this provider, applied as the
    
    
    
    this.maxAudioSeconds = null;
    this.maxAudioBytes = null;

    this.audioOverride = typeof config.supportsAudio === 'boolean'
      ? config.supportsAudio
      : null;
  }

  get supportsVision() {
    if (this.visionOverride !== null) return this.visionOverride;
    const model = (this.model || '').toLowerCase();
    return this.visionModels.some(prefix => prefix === '*' || model.includes(prefix));
  }

  /**
   * A model from this same provider that CAN take audio, or null.
   *
   * Exists because "the selected model cannot process audio" is a dead end for
   * the user unless something names the way out. Meta is the case that forced
   * it: the model they recommend, Muse Spark 1.3, is the one that cannot hear.
   */
  audioAlternative() {
    return null;
  }

  /**
   * Turn a clip into text, or null when this provider has no way to.
   *
   * A provider whose chat model cannot hear may still ship a dedicated
   * speech-to-text model on the same key — Meta does, and it is the whole answer
   * to Muse Spark 1.3 being both the recommended model and the deaf one.
   * Returning null means "no route", not "it failed"; a thrown error means the
   * route existed and did not work, which the caller reports differently.
   */
  async transcribeAudio() {
    return null;
  }

  
  get canTranscribe() {
    return false;
  }

  get supportsAudio() {
    if (this.audioOverride !== null) return this.audioOverride;
    const model = (this.model || '').toLowerCase();
    return this.audioModels.some(prefix => prefix === '*' || model.includes(prefix));
  }

  /**
   * Send a chat request to the LLM.
   * @param {Array} messages - [{ role: 'system'|'user'|'assistant', content: '...' }]
   * @param {Object} options - { temperature, maxTokens, jsonMode, tools }
   * @returns {Promise<{ content: string, usage: { promptTokens: number, completionTokens: number } }>}
   */
  async chat(messages, options = {}) {
    throw new Error('chat() must be implemented by provider');
  }

  /**
   * Prepare a message list for this specific model.
   *
   * Providers used to hardcode "strip every image block" because their whole
   * vendor was assumed blind. Now that vision is decided per model, that blanket
   * strip would delete images from models that can actually read them — so the
   * decision is made here, once, against supportsVision.
   */
  prepareMessages(messages) {
    const clean = this.stripInternalFields(messages);

    // Vision and audio are decided separately. A model can read images and not
    // hear audio (most of them), so the two strips cannot share one branch —
    // an audio-blind vision model used to keep its input_audio block and 400.
    const shaped = this.supportsVision
      ? clean.map(msg => this.normalizeImageBlocks(msg))
      : clean.map(msg => this.flattenToTextOnly(msg));

    return this.supportsAudio
      ? shaped.map(msg => this.normalizeAudioBlocks(msg))
      : shaped.map(msg => this.stripAudioBlocks(msg));
  }

  /**
   * Translate audio blocks into this provider's wire shape.
   *
   * The agent loop emits the OpenAI `input_audio` shape as the canonical form;
   * Gemini needs `inlineData`. History replayed from an earlier session — or
   * from before a provider switch — can carry either, so both are accepted.
   */
  normalizeAudioBlocks(msg) {
    if (!Array.isArray(msg.content)) return msg;

    const content = msg.content.map(block => {
      if (!block) return block;

      if (this.audioPayloadFormat === 'gemini') {
        if (block.type === 'input_audio') {
          return {
            inlineData: {
              mimeType: mimeTypeForAudioFormat(block.input_audio?.format),
              data: block.input_audio?.data
            }
          };
        }
        return block;
      }

      // OpenAI shape. Convert a Gemini-shaped block back if one is replayed.
      if (block.inlineData && String(block.inlineData.mimeType || '').startsWith('audio/')) {
        return {
          type: 'input_audio',
          input_audio: {
            data: block.inlineData.data,
            format: audioFormatForMimeType(block.inlineData.mimeType)
          }
        };
      }
      return block;
    });

    return { ...msg, content };
  }

  /**
   * Drop audio from a model that cannot hear, leaving a visible marker.
   *
   * Silently deleting it was the old behaviour and it was the worst possible
   * one: the user recorded a clip, the model answered as though it had heard
   * nothing, and nothing anywhere said why. Images already got a placeholder;
   * audio now gets the same courtesy.
   */
  stripAudioBlocks(msg) {
    if (!Array.isArray(msg.content)) return msg;
    if (!msg.content.some(isAudioBlock)) return msg;

    const content = msg.content
      .filter(block => !isAudioBlock(block))
      .concat([{
        type: 'text',
        text: '[Audio content removed — the selected model cannot process audio. Causyne transcribed the request on-device instead where possible.]'
      }]);

    return { ...msg, content };
  }

  /**
   * Translate image blocks into this provider's wire shape. The agent loop emits
   * whichever shape imagePayloadFormat asks for, but history replayed from an
   * earlier session — or from before a provider switch — can carry the other.
   */
  normalizeImageBlocks(msg) {
    if (!Array.isArray(msg.content)) return msg;
    if (this.imagePayloadFormat !== 'openai') return msg;

    const content = msg.content.map(block => {
      if (block && block.type === 'image' && block.source?.type === 'base64') {
        return {
          type: 'image_url',
          image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` }
        };
      }
      return block;
    });

    return { ...msg, content };
  }

  /**
   * Collapse multimodal content to plain text for a model that cannot see.
   *
   * Audio blocks are deliberately preserved here rather than filtered out:
   * this runs before the audio strip in prepareMessages, and a model that is
   * blind is not necessarily deaf. Flattening to a bare string at this point
   * would destroy an audio block that the audio branch was about to keep.
   */
  flattenToTextOnly(msg) {
    if (!Array.isArray(msg.content)) return msg;

    const audioBlocks = this.supportsAudio ? msg.content.filter(isAudioBlock) : [];

    const textParts = msg.content
      .filter(block => block.type === 'text')
      .map(block => block.text);

    const text = textParts.join('\n') ||
      '[Image content removed — not supported by this model]';

    if (audioBlocks.length === 0) return { ...msg, content: text };

    return { ...msg, content: [{ type: 'text', text }, ...audioBlocks] };
  }

  /** Remove internal bookkeeping fields before sending messages upstream. */
  stripInternalFields(messages) {
    return messages.map(msg => {
      let needsCopy = false;
      for (const field of INTERNAL_MESSAGE_FIELDS) {
        if (field in msg) { needsCopy = true; break; }
      }
      if (!needsCopy) return msg;

      const clean = { ...msg };
      for (const field of INTERNAL_MESSAGE_FIELDS) delete clean[field];
      return clean;
    });
  }

  // Normalize usage across different provider response formats.
  //
  // Cached prompt tokens are surfaced separately because they are billed at a
  // fraction of the base input rate: OpenAI-style APIs report them under
  // prompt_tokens_details.cached_tokens, DeepSeek under prompt_cache_hit_tokens.
  
  // disfavour once caching starts working.
  normalizeUsage(rawUsage) {
    const promptTokens = rawUsage?.prompt_tokens || 0;
    const cachedPromptTokens =
      rawUsage?.prompt_tokens_details?.cached_tokens ??
      rawUsage?.prompt_cache_hit_tokens ??
      0;

    return {
      promptTokens,
      completionTokens: rawUsage?.completion_tokens || 0,
      cachedPromptTokens: Math.min(cachedPromptTokens, promptTokens)
    };
  }
}
