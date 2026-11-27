import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { LLMProvider } from './base.js';
import { scanAndAdaptToolsForProvider } from '../tools/toolScanner.js';
import { normalizeOpenAIChatChoiceResponse } from './wireNormalizer.js';
import { ProviderHttpError, requireApiKey, resolveTemperature, safeProviderFetchJson } from './byokHttp.js';
import { streamOpenAICompatibleChat, wantsStreaming } from './byokStream.js';
import { resolveBudgetTokensForVariant } from '../modelVariants.js';
export class DashscopeByokProvider extends LLMProvider {
    allowInsecureHttp;
    reasoningEffort;
    constructor(config = {}) {
        super(config);
        const rawEffort = typeof config.reasoningEffort === 'string' ? config.reasoningEffort.trim().toLowerCase() : '';
        this.reasoningEffort = rawEffort || null;
        let url = (typeof config.baseUrl === 'string' ? config.baseUrl.trim() : '') || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';
        try {
            const parsed = new URL(url);
            if (parsed.pathname.endsWith('/v1')) {
                parsed.pathname += '/chat/completions';
                url = parsed.toString();
            }
            else if (parsed.pathname.endsWith('/v1/')) {
                parsed.pathname += 'chat/completions';
                url = parsed.toString();
            }
        }
        catch {
            if (url.endsWith('/v1'))
                url += '/chat/completions';
            else if (url.endsWith('/v1/'))
                url += 'chat/completions';
        }
        this.baseUrl = url;
        this.allowInsecureHttp = config.allowInsecureHttp === true;
        this.model = String(canonicalModelId(config.model || DEFAULT_MODEL_BY_PROVIDER['dashscope-byok']) || '');
        this.apiKey = config.apiKey;
        this.visionModels = ['-vl-', '-vl', 'qwen3.6', 'qwen3.7', 'kimi-k2.5', 'kimi-k2.7'];
        this.audioModels = ['-omni', 'qwen-audio', 'qwen2-audio'];
    }
    async chat(messages, options = {}) {
        const apiKey = requireApiKey(this.apiKey, 'Qwen DashScope');
        const activeModel = String(canonicalModelId(this.model || DEFAULT_MODEL_BY_PROVIDER['dashscope-byok'] || 'qwen3.7-plus') || 'qwen3.7-plus');
        const sanitizedMessages = this.prepareMessages(messages);
        const payload = {
            model: activeModel,
            messages: sanitizedMessages,
            temperature: resolveTemperature(options.temperature, 0.1)
        };
        if (this.reasoningEffort && /qwen3|qwen-3|qwq/i.test(activeModel)) {
            if (this.reasoningEffort === 'off' || this.reasoningEffort === 'none') {
                payload['enable_thinking'] = false;
            }
            else {
                payload['enable_thinking'] = true;
                const budget = resolveBudgetTokensForVariant(this.reasoningEffort, 32_768);
                if (budget && budget > 0) {
                    payload['thinking_budget'] = budget;
                }
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
            const scanReport = scanAndAdaptToolsForProvider(options.tools, 'dashscope');
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
                let host = '';
                try {
                    host = new URL(endpoint).hostname.toLowerCase();
                }
                catch {
                    host = '';
                }
                const hostHasWorkspace = host.includes('ws-');
                if (status === 401 && apiKey.startsWith('sk-ws-') && !hostHasWorkspace) {
                    throw new Error('\n[QWEN WORKSPACE CONFIGURATION ERROR]\n\nYou are using a Workspace-bound API Key (starts with sk-ws-), but you have not configured your Workspace Base URL.\n\nAlibaba requires a specific URL for these keys.\n\nHOW TO FIX THIS:\n1. Open your computer terminal.\n2. Run command: causyne config\n3. When asked for Custom Base URL, paste your Workspace URL from Alibaba (e.g. https://{Your-Workspace-ID}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions).\n\nAlternatively, use a Standard API Key (starts with sk-) which does not require a custom URL.');
                }
                if (status === 401 && (host === 'dashscope-intl.aliyuncs.com' || host === 'dashscope.aliyuncs.com')) {
                    const isIntl = host === 'dashscope-intl.aliyuncs.com';
                    const altRegion = isIntl ? 'China Mainland (Beijing)' : 'International (Singapore)';
                    const altUrl = isIntl
                        ? 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
                        : 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';
                    throw new Error(`Qwen DashScope authentication failed (HTTP 401) against ${host}. ` +
                        `If your API key was created in Alibaba Cloud ${altRegion}, run \`causyne config\` and set Custom Base URL to: ${altUrl}`);
                }
            }
        };
        const runDashscopeRequest = async (reqPayload) => (wantsStreaming(options)
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
            data = await runDashscopeRequest(payload);
        }
        catch (err) {
            const rejectedThinking = ('enable_thinking' in payload || 'thinking_budget' in payload)
                && err instanceof ProviderHttpError
                && err.status === 400
                && /(?:enable_thinking|thinking_budget|thinking|unsupported|not supported|invalid|unknown)/i.test(err.message);
            if (!rejectedThinking)
                throw err;
            const fallbackPayload = { ...payload };
            delete fallbackPayload['enable_thinking'];
            delete fallbackPayload['thinking_budget'];
            data = await runDashscopeRequest(fallbackPayload);
        }
        const normalized = normalizeOpenAIChatChoiceResponse(data, {
            prefix: 'call_dashscope',
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
