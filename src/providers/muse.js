import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { safeProviderFetchJson } from './byokHttp.js';
export const MUSE_BASE_URL = 'https://api.meta.ai/v1';
export const MUSE_CONTEXT_TOKENS = 1_048_576;
export const MUSE_IMAGE_MODEL = 'muse-image-1.0';
export const MUSE_TRANSCRIBE_MODEL = 'muse-voice-transcribe-1.0';
export const MUSE_CHAT_MODELS = [
    { id: 'muse-spark-1.3', tier: 'standard', audio: false, recommended: true },
    { id: 'muse-spark-1.3-contributor', tier: 'contributor', audio: false },
    { id: 'muse-spark-1.2', tier: 'standard', audio: true },
    { id: 'muse-spark-1.2-contributor', tier: 'contributor', audio: true },
    { id: 'muse-spark-1.1', tier: 'standard', audio: true }
];
const AUDIO_CAPABLE = MUSE_CHAT_MODELS.filter((m) => m.audio).map((m) => m.id);
export function isContributorModel(model) {
    return String(model || '').toLowerCase().endsWith('-contributor');
}
export function clampReasoningEffort(effort, model) {
    const requested = String(effort || '').toLowerCase();
    if (!requested || requested === 'off')
        return requested || null;
    if (requested === 'max' && isContributorModel(model))
        return 'high';
    return requested;
}
export class MuseProvider extends OpenAICompatibleProvider {
    contextTokens;
    constructor(config = {}) {
        super(config);
        this.baseUrl = `${MUSE_BASE_URL}/chat/completions`;
        this.providerLabel = 'Meta (Muse)';
        this.model = String(canonicalModelId(config.model || DEFAULT_MODEL_BY_PROVIDER['muse']) || '');
        this.visionModels = ['muse-spark'];
        this.imagePayloadFormat = 'openai';
        this.audioModels = AUDIO_CAPABLE;
        this.audioPayloadFormat = 'openai';
        this.maxAudioSeconds = null;
        this.maxAudioBytes = null;
        this.contextTokens = MUSE_CONTEXT_TOKENS;
        this.reasoningEffort = clampReasoningEffort(config.reasoningEffort, this.model);
    }
    audioAlternative() {
        if (this.supportsAudio)
            return null;
        return isContributorModel(this.model) ? 'muse-spark-1.2-contributor' : 'muse-spark-1.2';
    }
    get transcribeModel() {
        return MUSE_TRANSCRIBE_MODEL;
    }
    get transcribeUrl() {
        return `${MUSE_BASE_URL}/asr/transcribe`;
    }
    get canTranscribe() {
        return Boolean(this.apiKey) && process.env.CAUSYNE_MUSE_ASR === '1';
    }
    async transcribeAudio(base64, mimeType = 'audio/wav', options = {}) {
        if (!base64 || !this.apiKey)
            return null;
        const extension = String(mimeType).includes('mp3') ? 'mp3'
            : String(mimeType).includes('mp4') || String(mimeType).includes('m4a') ? 'm4a'
                : String(mimeType).includes('ogg') ? 'ogg'
                    : String(mimeType).includes('webm') ? 'webm'
                        : 'wav';
        const form = new FormData();
        form.append('model', MUSE_TRANSCRIBE_MODEL);
        form.append('file', new Blob([Buffer.from(base64, 'base64')], { type: mimeType }), `clip.${extension}`);
        const data = await safeProviderFetchJson({
            url: this.transcribeUrl,
            method: 'POST',
            headers: { Authorization: `Bearer ${this.apiKey}` },
            body: form,
            signal: options['signal'],
            timeoutMs: options['timeoutMs'],
            providerLabel: 'Muse Voice Transcribe',
            secrets: [this.apiKey],
            hasApiKey: true
        });
        const text = data['text']
            || data['transcript']
            || (Array.isArray(data['turns']) ? data['turns'].map((t) => t.text).filter(Boolean).join(' ') : '');
        return String(text || '').trim() || null;
    }
}
