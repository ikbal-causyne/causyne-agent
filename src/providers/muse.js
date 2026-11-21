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
const VALID_MUSE_EFFORTS = new Set(['low', 'medium', 'high', 'max', 'off']);
export function clampReasoningEffort(effort, model) {
    const requested = String(effort || '').trim().toLowerCase();
    if (!requested || !VALID_MUSE_EFFORTS.has(requested))
        return null;
    if (requested === 'off')
        return 'off';
    if (requested === 'max' && isContributorModel(model))
        return 'high';
    return requested;
}
export class MuseProvider extends OpenAICompatibleProvider {
    contextTokens;
    constructor(config = {}) {
        super(config);
        if (!config.baseUrl)
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
        const key = typeof this.apiKey === 'string' ? this.apiKey.trim() : '';
        return Boolean(key) && process.env.CAUSYNE_MUSE_ASR === '1';
    }
    async transcribeAudio(base64, mimeType = 'audio/wav', options = {}) {
        const key = typeof this.apiKey === 'string' ? this.apiKey.trim() : '';
        if (typeof base64 !== 'string' || !base64.trim() || !key)
            return null;
        const maxAudioBytes = 25 * 1024 * 1024;
        const audioBuf = Buffer.from(base64, 'base64');
        if (audioBuf.byteLength === 0 || audioBuf.byteLength > maxAudioBytes) {
            throw new Error(`Muse Voice Transcribe audio clip exceeds maximum size (${maxAudioBytes} bytes).`);
        }
        const extension = String(mimeType).includes('mp3') ? 'mp3'
            : String(mimeType).includes('mp4') || String(mimeType).includes('m4a') ? 'm4a'
                : String(mimeType).includes('ogg') ? 'ogg'
                    : String(mimeType).includes('webm') ? 'webm'
                        : 'wav';
        const form = new FormData();
        form.append('model', MUSE_TRANSCRIBE_MODEL);
        form.append('file', new Blob([audioBuf], { type: mimeType }), `clip.${extension}`);
        const opts = options && typeof options === 'object' ? options : {};
        const data = await safeProviderFetchJson({
            url: this.transcribeUrl,
            method: 'POST',
            headers: { Authorization: `Bearer ${key}` },
            body: form,
            signal: opts['signal'],
            timeoutMs: opts['timeoutMs'],
            providerLabel: 'Muse Voice Transcribe',
            secrets: [key],
            hasApiKey: true,
            allowInsecureHttp: this.allowInsecureHttp
        });
        const safeData = data && typeof data === 'object' ? data : {};
        const text = safeData['text']
            || safeData['transcript']
            || (Array.isArray(safeData['turns']) ? safeData['turns'].map((t) => (t && typeof t === 'object' && typeof t.text === 'string' ? t.text : '')).filter(Boolean).join(' ') : '');
        return String(text || '').trim() || null;
    }
}
