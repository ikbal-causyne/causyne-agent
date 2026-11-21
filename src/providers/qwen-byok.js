import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { LLMProvider } from './base.js';
import { scanAndAdaptToolsForProvider } from '../tools/toolScanner.js';
import { normalizeOpenAIChatChoiceResponse } from './wireNormalizer.js';
import { requireApiKey, resolveTemperature, safeProviderFetchJson } from './byokHttp.js';
import { streamOpenAICompatibleChat, wantsStreaming } from './byokStream.js';
export class QwenByokProvider extends LLMProvider {
    allowInsecureHttp;
    constructor(config = {}) {
        super(config);
        let url = config.baseUrl || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';
        if (url.endsWith('/v1'))
            url += '/chat/completions';
        else if (url.endsWith('/v1/'))
            url += 'chat/completions';
        this.baseUrl = url;
        this.allowInsecureHttp = config.allowInsecureHttp === true;
        this.model = String(canonicalModelId(config.model || DEFAULT_MODEL_BY_PROVIDER['qwen']) || '');
        this.apiKey = config.apiKey;
        this.visionModels = ['-vl-', '-vl', 'qwen3.6', 'qwen3.7'];
        this.audioModels = ['-omni', 'qwen-audio', 'qwen2-audio'];
    }
    async chat(messages, options = {}) {
        const apiKey = requireApiKey(this.apiKey, 'Qwen DashScope');
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
            const scanReport = scanAndAdaptToolsForProvider(options.tools, 'qwen');
            payload['tools'] = scanReport.adaptedTools;
            payload['tool_choice'] = 'auto';
            freeFormPaths = scanReport.freeFormPaths;
        }
        const endpoint = this.baseUrl || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';
        const requestOpts = {
            url: endpoint,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            signal: options.signal,
            timeoutMs: options.timeoutMs,
            providerLabel: 'Qwen DashScope',
            secrets: [apiKey],
            hasApiKey: true,
            allowInsecureHttp: this.allowInsecureHttp,
            onHttpError: ({ status }) => {
                if (status === 401 && apiKey.startsWith('sk-ws-') && !endpoint.includes('ws-')) {
                    throw new Error('\n[QWEN WORKSPACE CONFIGURATION ERROR]\n\nYou are using a Workspace-bound API Key (starts with sk-ws-), but you have not configured your Workspace Base URL.\n\nAlibaba requires a specific URL for these keys.\n\nHOW TO FIX THIS:\n1. Open your computer terminal.\n2. Run command: causyne config\n3. When asked for Custom Base URL, paste your Workspace URL from Alibaba (e.g. https://{Your-Workspace-ID}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions).\n\nAlternatively, use a Standard API Key (starts with sk-) which does not require a custom URL.');
                }
            }
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
            prefix: 'call_qwen',
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
