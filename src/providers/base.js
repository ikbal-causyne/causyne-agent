import { canonicalModelId } from '../modelIds.js';
// Fields the agent loop attaches to messages for its own bookkeeping. They must
// never reach a provider API, which rejects unknown message properties.
const INTERNAL_MESSAGE_FIELDS = [
    'cacheAnchor',
    'spillPath',
    'causyne_synthetic_no_final',
    'external_actions'
];
// Container formats each vendor accepts for audio input.
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
    const key = String(format || '').trim().toLowerCase();
    return Object.hasOwn(AUDIO_MIME_BY_FORMAT, key) ? AUDIO_MIME_BY_FORMAT[key] : 'audio/wav';
}
/**
 * Map a MIME type to the short format token OpenAI's input_audio expects.
 */
export function audioFormatForMimeType(mimeType) {
    const mime = String(mimeType || '').toLowerCase().split(';')[0]?.trim() || '';
    for (const [format, candidate] of Object.entries(AUDIO_MIME_BY_FORMAT)) {
        if (candidate === mime)
            return format;
    }
    if (mime === 'audio/mp3' || mime === 'audio/x-mpeg')
        return 'mp3';
    if (mime === 'audio/x-wav' || mime === 'audio/wave')
        return 'wav';
    if (mime === 'audio/x-m4a')
        return 'm4a';
    if (mime === 'audio/x-flac')
        return 'flac';
    if (mime === 'audio/x-aac')
        return 'aac';
    return 'wav';
}
/** True for an audio content block in either the OpenAI or the Gemini shape. */
export function isAudioBlock(block) {
    if (!block || typeof block !== 'object')
        return false;
    if (block.type === 'input_audio')
        return true;
    return Boolean(block.inlineData && String(block.inlineData.mimeType || '').startsWith('audio/'));
}
export class LLMProvider {
    apiKey;
    model;
    baseUrl;
    visionModels;
    imagePayloadFormat;
    visionOverride;
    audioModels;
    audioPayloadFormat;
    maxAudioSeconds;
    maxAudioBytes;
    audioOverride;
    preserveThinkingBlocks;
    preserveReasoningContent;
    constructor(config) {
        const cfg = config && typeof config === 'object' ? config : {};
        this.apiKey = cfg.apiKey;
        this.model = String(canonicalModelId(cfg.model ?? '') || '');
        this.baseUrl = cfg.baseUrl;
        this.visionModels = [];
        this.imagePayloadFormat = 'openai';
        this.visionOverride = typeof cfg.supportsVision === 'boolean'
            ? cfg.supportsVision
            : null;
        this.audioModels = [];
        this.audioPayloadFormat = 'openai';
        this.maxAudioSeconds = null;
        this.maxAudioBytes = null;
        this.audioOverride = typeof cfg.supportsAudio === 'boolean'
            ? cfg.supportsAudio
            : null;
        this.preserveThinkingBlocks = false;
        this.preserveReasoningContent = false;
    }
    get supportsVision() {
        if (this.visionOverride !== null)
            return this.visionOverride;
        const model = (this.model || '').toLowerCase();
        return this.visionModels.some(prefix => prefix === '*' || model.includes(prefix));
    }
    audioAlternative() {
        return null;
    }
    async transcribeAudio(_base64, _mimeType, _options) {
        return null;
    }
    get canTranscribe() {
        return false;
    }
    get supportsAudio() {
        if (this.audioOverride !== null)
            return this.audioOverride;
        const model = (this.model || '').toLowerCase();
        return this.audioModels.some(prefix => prefix === '*' || model.includes(prefix));
    }
    async chat(_messages, _options = {}) {
        throw new Error('chat() must be implemented by provider');
    }
    prepareMessages(messages) {
        const clean = this.stripInternalFields(messages);
        const shaped = this.supportsVision
            ? clean.map(msg => this.normalizeImageBlocks(msg))
            : clean.map(msg => this.flattenToTextOnly(msg));
        return this.supportsAudio
            ? shaped.map(msg => this.normalizeAudioBlocks(msg))
            : shaped.map(msg => this.stripAudioBlocks(msg));
    }
    normalizeAudioBlocks(msg) {
        if (!Array.isArray(msg.content))
            return msg;
        const content = msg.content.map((block) => {
            if (!block || typeof block !== 'object')
                return block;
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
    stripAudioBlocks(msg) {
        if (!Array.isArray(msg.content))
            return msg;
        if (!msg.content.some(isAudioBlock))
            return msg;
        const content = msg.content
            .filter((block) => !isAudioBlock(block))
            .concat([{
                type: 'text',
                text: '[Audio content removed — the selected model cannot process audio. Causyne transcribed the request on-device instead where possible.]'
            }]);
        return { ...msg, content };
    }
    normalizeImageBlocks(msg) {
        if (!Array.isArray(msg.content))
            return msg;
        if (this.imagePayloadFormat === 'anthropic') {
            const content = msg.content.map((block) => {
                if (block && block.type === 'image_url' && typeof block.image_url?.url === 'string') {
                    const commaIdx = block.image_url.url.indexOf('base64,');
                    if (commaIdx !== -1 && block.image_url.url.startsWith('data:')) {
                        const rawMedia = (block.image_url.url.slice(5, commaIdx).split(';')[0] || 'image/png').trim().toLowerCase();
                        const mediaType = rawMedia === 'image/jpg' ? 'image/jpeg' : rawMedia;
                        const data = block.image_url.url.slice(commaIdx + 7);
                        if (data)
                            return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
                    }
                }
                return block;
            });
            return { ...msg, content };
        }
        if (this.imagePayloadFormat !== 'openai')
            return msg;
        const content = msg.content.map((block) => {
            if (block && block.type === 'image' && block.source?.type === 'base64' && typeof block.source.data === 'string' && block.source.data) {
                const mime = typeof block.source.media_type === 'string' && block.source.media_type ? block.source.media_type : 'image/png';
                return {
                    type: 'image_url',
                    image_url: { url: `data:${mime};base64,${block.source.data}` }
                };
            }
            return block;
        });
        return { ...msg, content };
    }
    flattenToTextOnly(msg) {
        if (!Array.isArray(msg.content))
            return msg;
        const audioBlocks = this.supportsAudio ? msg.content.filter(isAudioBlock) : [];
        const textParts = msg.content
            .filter((block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text);
        const text = textParts.join('\n') ||
            '[Image content removed — not supported by this model]';
        if (audioBlocks.length === 0)
            return { ...msg, content: text };
        return { ...msg, content: [{ type: 'text', text }, ...audioBlocks] };
    }
    stripInternalFields(messages) {
        if (!Array.isArray(messages))
            return [];
        const fieldsToStrip = [...INTERNAL_MESSAGE_FIELDS, 'thoughtSignature'];
        if (!this.preserveThinkingBlocks)
            fieldsToStrip.push('thinking_blocks');
        if (!this.preserveReasoningContent)
            fieldsToStrip.push('reasoning_content');
        return messages.filter((msg) => msg && typeof msg === 'object').map(msg => {
            let needsCopy = false;
            for (const field of fieldsToStrip) {
                if (field in msg) {
                    needsCopy = true;
                    break;
                }
            }
            if (!needsCopy)
                return msg;
            const clean = { ...msg };
            for (const field of fieldsToStrip)
                delete clean[field];
            return clean;
        });
    }
    normalizeUsage(rawUsage) {
        const nonNeg = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
        const promptTokens = nonNeg(rawUsage?.prompt_tokens);
        const completionTokens = nonNeg(rawUsage?.completion_tokens);
        const rawCached = rawUsage?.prompt_tokens_details?.cached_tokens ??
            rawUsage?.prompt_cache_hit_tokens ??
            rawUsage?.cache_read_input_tokens ??
            0;
        const cachedPromptTokens = Math.min(nonNeg(rawCached), promptTokens);
        const hasProviderTokens = promptTokens > 0 || completionTokens > 0;
        return {
            promptTokens,
            completionTokens,
            cachedPromptTokens,
            ...(hasProviderTokens ? { measurement: 'provider_reported' } : {})
        };
    }
}
