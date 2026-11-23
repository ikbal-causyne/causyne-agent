import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { LLMProvider } from './base.js';
import { scanAndAdaptToolsForProvider } from '../tools/toolScanner.js';
import { normalizeOpenAIChatChoiceResponse } from './wireNormalizer.js';
import { requireApiKey, resolveTemperature, safeProviderFetchJson } from './byokHttp.js';
import { streamOpenAICompatibleChat, wantsStreaming } from './byokStream.js';
export class DeepSeekProvider extends LLMProvider {
    allowInsecureHttp;
    constructor(config = {}) {
        super(config);
        const customUrl = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : '';
        this.baseUrl = customUrl || 'https://api.deepseek.com/v1/chat/completions';
        this.allowInsecureHttp = config.allowInsecureHttp === true;
        this.model = String(canonicalModelId(config.model || DEFAULT_MODEL_BY_PROVIDER['deepseek']) || '');
        this.visionModels = ['-vl'];
        this.audioModels = [];
        this.preserveReasoningContent = true;
    }
    isReasonerModel() {
        const lowered = (this.model || '').trim().toLowerCase();
        return lowered.includes('reasoner') || lowered.startsWith('deepseek-r1');
    }
    async chat(messages, options = {}) {
        const apiKey = requireApiKey(this.apiKey, 'DeepSeek');
        const isReasoner = this.isReasonerModel();
        const rawPrepared = this.prepareMessages(messages);
        const sanitizedMessages = isReasoner
            ? rawPrepared.map((msg) => {
                if (msg?.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0 && typeof msg.reasoning_content !== 'string') {
                    return { ...msg, reasoning_content: '' };
                }
                return msg;
            })
            : rawPrepared;
        const payload = {
            model: this.model,
            messages: sanitizedMessages
        };
        if (!isReasoner) {
            payload['temperature'] = resolveTemperature(options.temperature, 0.1);
        }
        if (typeof options.maxTokens === 'number' && Number.isFinite(options.maxTokens) && options.maxTokens >= 1) {
            payload['max_tokens'] = Math.floor(options.maxTokens);
        }
        if (options.jsonMode) {
            payload['response_format'] = { type: 'json_object' };
        }
        let freeFormPaths = new Map();
        if (options.tools && options.tools.length > 0) {
            const scanReport = scanAndAdaptToolsForProvider(options.tools, 'deepseek');
            payload['tools'] = scanReport.adaptedTools;
            payload['tool_choice'] = 'auto';
            freeFormPaths = scanReport.freeFormPaths;
        }
        const endpoint = this.baseUrl || 'https://api.deepseek.com/v1/chat/completions';
        const requestOpts = {
            url: endpoint,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            signal: options.signal,
            timeoutMs: options.timeoutMs,
            providerLabel: 'DeepSeek',
            secrets: [apiKey],
            hasApiKey: true,
            allowInsecureHttp: this.allowInsecureHttp
        };
        const data = wantsStreaming(options)
            ? await streamOpenAICompatibleChat({
                ...requestOpts,
                payload,
                onChunk: options.onChunk,
                onReasoningChunk: options.onReasoningChunk
            })
            : await safeProviderFetchJson({
                ...requestOpts,
                body: JSON.stringify(payload)
            });
        const normalized = normalizeOpenAIChatChoiceResponse(data, {
            prefix: 'call_deepseek',
            freeFormPaths
        });
        return {
            content: normalized.content,
            toolCalls: normalized.toolCalls,
            reasoningContent: normalized.reasoningContent,
            usage: this.normalizeUsage(normalized.rawUsage)
        };
    }
}
