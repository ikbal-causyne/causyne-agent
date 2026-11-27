import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { LLMProvider } from './base.js';
import { scanAndAdaptToolsForProvider } from '../tools/toolScanner.js';
import { normalizeOpenAIChatChoiceResponse } from './wireNormalizer.js';
import { ProviderHttpError, requireApiKey, resolveTemperature, safeProviderFetchJson } from './byokHttp.js';
import { streamOpenAICompatibleChat, wantsStreaming } from './byokStream.js';
export class XAIProvider extends LLMProvider {
    allowInsecureHttp;
    reasoningEffort;
    constructor(config = {}) {
        super(config);
        const customUrl = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : '';
        this.baseUrl = customUrl || 'https://api.x.ai/v1/chat/completions';
        this.allowInsecureHttp = config.allowInsecureHttp === true;
        const rawEffort = typeof config.reasoningEffort === 'string' ? config.reasoningEffort.trim().toLowerCase() : '';
        const clampedEffort = (rawEffort === 'max' || rawEffort === 'ultra') ? 'high' : (rawEffort === 'minimal' ? 'low' : rawEffort);
        const allowedEfforts = new Set(['low', 'medium', 'high', 'xhigh']);
        this.reasoningEffort = allowedEfforts.has(clampedEffort) ? clampedEffort : null;
        this.model = String(canonicalModelId(config.model || DEFAULT_MODEL_BY_PROVIDER['xai']) || '');
        this.visionModels = ['grok-4', 'vision'];
        this.audioModels = [];
    }
    async chat(messages, options = {}) {
        const apiKey = requireApiKey(this.apiKey, 'xAI (Grok)');
        const sanitizedMessages = this.prepareMessages(messages);
        const payload = {
            model: this.model,
            messages: sanitizedMessages,
            temperature: resolveTemperature(options.temperature, 0.1)
        };
        const loweredModel = (this.model || '').toLowerCase();
        if (this.reasoningEffort && !loweredModel.includes('non-reasoning')) {
            if (loweredModel.includes('grok-420-reasoning') || (loweredModel.includes('grok-4') && loweredModel.includes('reasoning'))) {
                payload['reasoning_effort'] = this.reasoningEffort;
            }
            else if (loweredModel.includes('grok-3-mini')) {
                payload['reasoning_effort'] = this.reasoningEffort === 'low' ? 'low' : 'high';
            }
        }
        if (typeof options.maxTokens === 'number' && Number.isFinite(options.maxTokens) && options.maxTokens >= 1) {
            payload['max_tokens'] = Math.floor(options.maxTokens);
        }
        if (options.jsonMode) {
            payload['response_format'] = { type: 'json_object' };
        }
        let freeFormPaths = new Map();
        if (options.tools && options.tools.length > 0) {
            const scanReport = scanAndAdaptToolsForProvider(options.tools, 'xai');
            payload['tools'] = scanReport.adaptedTools;
            payload['tool_choice'] = 'auto';
            freeFormPaths = scanReport.freeFormPaths;
        }
        const endpoint = this.baseUrl || 'https://api.x.ai/v1/chat/completions';
        const requestOpts = {
            url: endpoint,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            signal: options.signal,
            timeoutMs: options.timeoutMs,
            providerLabel: 'xAI',
            secrets: [apiKey],
            hasApiKey: true,
            allowInsecureHttp: this.allowInsecureHttp
        };
        const runXaiRequest = async (reqPayload) => (wantsStreaming(options)
            ? await streamOpenAICompatibleChat({
                ...requestOpts,
                payload: reqPayload,
                onChunk: options.onChunk,
                onReasoningChunk: options.onReasoningChunk
            })
            : await safeProviderFetchJson({
                ...requestOpts,
                body: JSON.stringify(reqPayload)
            }));
        let data;
        try {
            data = await runXaiRequest(payload);
        }
        catch (err) {
            const rejectedEffort = 'reasoning_effort' in payload
                && err instanceof ProviderHttpError
                && err.status === 400
                && /(?:reasoning_effort|effort|unsupported|not supported|invalid|unknown)/i.test(err.message);
            if (!rejectedEffort)
                throw err;
            const fallbackPayload = { ...payload };
            delete fallbackPayload['reasoning_effort'];
            data = await runXaiRequest(fallbackPayload);
        }
        const normalized = normalizeOpenAIChatChoiceResponse(data, {
            prefix: 'call_xai',
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
