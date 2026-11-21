import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { LLMProvider } from './base.js';
import { scanAndAdaptToolsForProvider } from '../tools/toolScanner.js';
import { normalizeOpenAIChatChoiceResponse } from './wireNormalizer.js';
import { requireApiKey, resolveTemperature, safeProviderFetchJson } from './byokHttp.js';
import { streamOpenAICompatibleChat, wantsStreaming } from './byokStream.js';
export class DeepSeekProvider extends LLMProvider {
    constructor(config = {}) {
        super(config);
        this.baseUrl = 'https://api.deepseek.com/v1/chat/completions';
        this.model = String(canonicalModelId(config.model || DEFAULT_MODEL_BY_PROVIDER['deepseek']) || '');
        this.visionModels = ['-vl'];
        this.audioModels = [];
    }
    async chat(messages, options = {}) {
        const apiKey = requireApiKey(this.apiKey, 'DeepSeek');
        const sanitizedMessages = this.prepareMessages(messages);
        const payload = {
            model: this.model,
            messages: sanitizedMessages,
            temperature: resolveTemperature(options.temperature, 0.1)
        };
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
            hasApiKey: true
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
