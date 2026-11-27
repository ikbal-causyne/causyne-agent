import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
export function clampOpenAIReasoningEffort(rawEffort, model) {
    const requested = typeof rawEffort === 'string' ? rawEffort.trim().toLowerCase() : '';
    if (!requested)
        return null;
    const lowered = typeof model === 'string' ? model.trim().toLowerCase() : '';
    if (!lowered || lowered.includes('-chat'))
        return null;
    // o1-pro / o3-pro / o4-pro only accept medium | high
    if (/^o[134]-pro(?:$|[-.])/.test(lowered)) {
        if (requested === 'off' || requested === 'none')
            return null;
        if (requested === 'minimal' || requested === 'low' || requested === 'medium')
            return 'medium';
        if (['high', 'xhigh', 'max', 'ultra'].includes(requested))
            return 'high';
        return null;
    }
    // o1 / o3 / o4-mini only accept low | medium | high
    if (/^o[134](?:$|[-.])/.test(lowered)) {
        if (requested === 'off' || requested === 'none')
            return null;
        if (requested === 'minimal' || requested === 'low')
            return 'low';
        if (requested === 'medium')
            return 'medium';
        if (['high', 'xhigh', 'max', 'ultra'].includes(requested))
            return 'high';
        return null;
    }
    // GPT-5.2+ / GPT-6 / Codex accept none | low | medium | high | xhigh (plus off -> none)
    if (/^gpt-[56](?:$|[-.])/.test(lowered)) {
        const supportsXhigh = /^gpt-5\.[2-9]|^gpt-6|codex/i.test(lowered);
        if (supportsXhigh) {
            if (requested === 'off' || requested === 'none')
                return 'none';
            if (requested === 'minimal' || requested === 'low')
                return 'low';
            if (requested === 'medium')
                return 'medium';
            if (requested === 'high')
                return 'high';
            if (['xhigh', 'max', 'ultra'].includes(requested))
                return 'xhigh';
            return null;
        }
        // GPT-5.0 / 5.1 accept minimal | low | medium | high
        if (requested === 'off' || requested === 'none' || requested === 'minimal')
            return 'minimal';
        if (requested === 'low')
            return 'low';
        if (requested === 'medium')
            return 'medium';
        if (['high', 'xhigh', 'max', 'ultra'].includes(requested))
            return 'high';
        return null;
    }
    return null;
}
export class OpenAIProvider extends OpenAICompatibleProvider {
    constructor(config = {}) {
        super(config);
        if (!config.baseUrl)
            this.baseUrl = 'https://api.openai.com/v1/chat/completions';
        this.providerLabel = 'OpenAI';
        this.model = String(canonicalModelId(config.model || DEFAULT_MODEL_BY_PROVIDER['openai']) || '');
        this.visionModels = ['*'];
        this.imagePayloadFormat = 'openai';
        this.audioModels = ['gpt-4o-audio', 'gpt-4o-mini-audio', 'gpt-audio', 'gpt-realtime'];
        this.audioPayloadFormat = 'openai';
        this.preserveReasoningContent = false;
        this.reasoningEffort = clampOpenAIReasoningEffort(this.reasoningEffort, this.model);
    }
    resolvePayloadReasoningEffort() {
        return clampOpenAIReasoningEffort(this.reasoningEffort, this.model);
    }
    rejectsSamplingParameters() {
        const lowered = (this.model || '').trim().toLowerCase();
        if (/^o[134](?:$|[-.])/.test(lowered))
            return true;
        if (/^gpt-[56](?:$|[-.])/.test(lowered) && !lowered.includes('-chat')) {
            return this.reasoningEffort !== 'none' && this.reasoningEffort !== 'off';
        }
        return false;
    }
    usesMaxCompletionTokens() {
        const lowered = (this.model || '').trim().toLowerCase();
        return /^o[134](?:$|[-.])/.test(lowered) || /^gpt-[56](?:$|[-.])/.test(lowered);
    }
    supportsPromptCacheKey() {
        if (!this.baseUrl)
            return false;
        try {
            const host = new URL(this.baseUrl).hostname.toLowerCase();
            return host === 'api.openai.com';
        }
        catch {
            return false;
        }
    }
    supportsReasoningEffort() {
        const lowered = (this.model || '').trim().toLowerCase();
        return (/^o[134](?:$|[-.])/.test(lowered) || /^gpt-[56](?:$|[-.])/.test(lowered))
            && !lowered.includes('-chat');
    }
}
