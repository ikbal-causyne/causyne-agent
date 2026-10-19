import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

/**
 * Meta Model API — the Muse family.
 *
 * Drop-in OpenAI-compatible, so this extends the compatible provider rather
 * than reimplementing the wire format. Everything below is the part that is
 * NOT generic: which models can see, which can hear, which reasoning levels a
 * given tier will actually accept, and how wide the context is.
 *
 * Model IDs verified against the live status page (all seven operational):
 * muse-spark-1.3, muse-spark-1.3-contributor, muse-spark-1.2,
 * muse-spark-1.2-contributor, muse-spark-1.1, muse-image-1.0,
 * muse-voice-transcribe-1.0.
 */

export const MUSE_BASE_URL = 'https://api.meta.ai/v1';

/** Every Muse Spark model shares this. Not a guess — it is the published spec. */
export const MUSE_CONTEXT_TOKENS = 1_048_576;

/** The image and speech models, which are not chat models and are reached elsewhere. */
export const MUSE_IMAGE_MODEL = 'muse-image-1.0';
export const MUSE_TRANSCRIBE_MODEL = 'muse-voice-transcribe-1.0';

/**
 * Chat models, newest first, with what each one can actually do.
 *
 * `audio: false` on 1.3 is not caution, it is the documented state: "Audio
 * understanding in Muse Spark 1.3 is currently not fully supported, and
 * response quality for requests including audio content may be degraded."
 * Advertising it would send a voice clip into a model that answers badly and
 * charges for it — worse than declining, because the user cannot tell a
 * degraded answer from a wrong one.
 */
export const MUSE_CHAT_MODELS = [
  { id: 'muse-spark-1.3', tier: 'standard', audio: false, recommended: true },
  { id: 'muse-spark-1.3-contributor', tier: 'contributor', audio: false },
  { id: 'muse-spark-1.2', tier: 'standard', audio: true },
  { id: 'muse-spark-1.2-contributor', tier: 'contributor', audio: true },
  { id: 'muse-spark-1.1', tier: 'standard', audio: true }
];

/** Models that accept audio, as bare id prefixes for LLMProvider.supportsAudio. */
const AUDIO_CAPABLE = MUSE_CHAT_MODELS.filter((m) => m.audio).map((m) => m.id);

/** Is this a Contributor-tier model? Its inputs and outputs train Meta's models. */
export function isContributorModel(model) {
  return String(model || '').toLowerCase().endsWith('-contributor');
}

/**
 * Reasoning effort the model will actually accept.
 *
 * `"max"` is Standard tier only. Sending it to a `-contributor` model is a
 * rejected request, and a rejected request in the middle of an agent loop looks
 * to the user like the agent broke — so it is stepped down here, once, where
 * the reason can be written down.
 */
export function clampReasoningEffort(effort, model) {
  const requested = String(effort || '').toLowerCase();
  if (!requested || requested === 'off') return requested || null;
  if (requested === 'max' && isContributorModel(model)) return 'high';
  return requested;
}

export class MuseProvider extends OpenAICompatibleProvider {
  constructor(config) {
    super(config);

    this.baseUrl = `${MUSE_BASE_URL}/chat/completions`;
    this.model = canonicalModelId(config.model || DEFAULT_MODEL_BY_PROVIDER['muse']);

    // Every Spark model takes text, image, video and PDF. The prefix covers all
    // five ids including the -contributor variants, which share the exact same
    // modalities as their Standard twins.
    this.visionModels = ['muse-spark'];
    this.imagePayloadFormat = 'openai';

    // Audio is the one capability that is NOT uniform across the family.
    this.audioModels = AUDIO_CAPABLE;
    this.audioPayloadFormat = 'openai';

    // Meta publishes no per-clip ceiling for Muse Spark, so no vendor clamp is
    
    // "this vendor adds no limit of its own", not "unlimited".
    this.maxAudioSeconds = null;
    this.maxAudioBytes = null;

    this.contextTokens = MUSE_CONTEXT_TOKENS;
    this.reasoningEffort = clampReasoningEffort(config.reasoningEffort, this.model);
  }

  /**
   * The transcription model exists for exactly the case 1.3 creates.
   *
   * The recommended chat model cannot hear, and Meta's answer to that is a
   * dedicated speech-to-text model on the same key and the same base URL. This
   * is what lets the agent loop offer the user a real route instead of only a
   * refusal.
   */
  audioAlternative() {
    if (this.supportsAudio) return null;
    // Keep the tier the user chose: someone on Contributor is there for the
    // price, and answering "switch to Standard" would quietly multiply it by
    // twelve.
    return isContributorModel(this.model) ? 'muse-spark-1.2-contributor' : 'muse-spark-1.2';
  }

  get transcribeModel() {
    return MUSE_TRANSCRIBE_MODEL;
  }

  get transcribeUrl() {
    return `${MUSE_BASE_URL}/asr/transcribe`;
  }

  /**
   * Transcribe a clip with Muse Voice Transcribe.
   *
   * THE REQUEST SHAPE IS INFERRED, and that is stated rather than hidden. Meta
   * documents the endpoint (`POST /v1/asr/transcribe`) and states that Model API
   * is drop-in compatible with the OpenAI SDK, so this sends the multipart form
   * that OpenAI's transcription endpoint takes. If that inference is wrong the
   * request fails, the caller catches it, and the user lands exactly where they
   * would have without this method — never worse, and told why.
   *
   * Returns the transcript, or null when there is nothing to send.
   */
  
  get canTranscribe() {
    return Boolean(this.apiKey) && process.env.CAUSYNE_MUSE_ASR === '1';
  }

  async transcribeAudio(base64, mimeType = 'audio/wav') {
    if (!base64 || !this.apiKey) return null;

    const extension = String(mimeType).includes('mp3') ? 'mp3'
      : String(mimeType).includes('mp4') || String(mimeType).includes('m4a') ? 'm4a'
      : String(mimeType).includes('ogg') ? 'ogg'
      : String(mimeType).includes('webm') ? 'webm'
      : 'wav';

    const form = new FormData();
    form.append('model', MUSE_TRANSCRIBE_MODEL);
    form.append('file', new Blob([Buffer.from(base64, 'base64')], { type: mimeType }), `clip.${extension}`);

    const response = await fetch(this.transcribeUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Muse Voice Transcribe (${response.status}): ${detail.slice(0, 400)}`);
    }

    const data = await response.json();
    // Accept the shapes a transcription endpoint plausibly answers in, rather
    // than betting the feature on one field name.
    const text = data.text
      || data.transcript
      || (Array.isArray(data.turns) ? data.turns.map((t) => t.text).filter(Boolean).join(' ') : '');
    return String(text || '').trim() || null;
  }
}
