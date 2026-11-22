import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
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
        const allowedEfforts = new Set(['low', 'medium', 'high', 'xhigh', 'minimal', 'none', 'off']);
        if (this.reasoningEffort && !allowedEfforts.has(this.reasoningEffort)) {
            this.reasoningEffort = null;
        }
    }
    rejectsSamplingParameters() {
        const lowered = (this.model || '').trim().toLowerCase();
        return /^o[134](?:$|[-.])/.test(lowered);
    }
    usesMaxCompletionTokens() {
        return this.rejectsSamplingParameters();
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
}
