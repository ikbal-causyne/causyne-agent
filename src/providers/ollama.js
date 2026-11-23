import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { LLMProvider } from './base.js';
import { scanAndAdaptToolsForProvider } from '../tools/toolScanner.js';
import { normalizeMessagesForOllama, normalizeOpenAIToolCalls, extractTextToolCalls } from './wireNormalizer.js';
import { stripToolCallMarkup } from '../implementationPlan.js';
import { formatToolContracts } from './toolContracts.js';
import { ProviderHttpError, resolveTemperature, safeProviderFetchJson } from './byokHttp.js';
import { streamOllamaChat, wantsStreaming } from './byokStream.js';
const OLLAMA_META_TTL_MS = 10 * 60 * 1000;
const ollamaMetaCache = new Map();
export function clearOllamaModelMetaCache() {
    ollamaMetaCache.clear();
}
export function ollamaOriginUrl(rawUrl) {
    const fallback = 'http://localhost:11434';
    const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    if (!trimmed)
        return fallback;
    try {
        const parsed = new URL(trimmed);
        const cleanedPath = parsed.pathname
            .replace(/\/(?:api\/(?:chat|generate|tags|show|ps)|v1\/chat\/completions|v1)\/?$/i, '')
            .replace(/\/+$/, '');
        parsed.pathname = cleanedPath || '/';
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString().replace(/\/+$/, '');
    }
    catch {
        return trimmed
            .replace(/\/(?:api\/(?:chat|generate|tags|show|ps)|v1\/chat\/completions|v1)\/?$/i, '')
            .replace(/\/+$/, '') || fallback;
    }
}
function parsePositiveCtx(value) {
    const num = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() ? Number(value.trim()) : NaN);
    if (!Number.isFinite(num) || num < 2048)
        return null;
    return Math.min(131_072, Math.floor(num));
}
export class OllamaProvider extends LLMProvider {
    allowInsecureHttp;
    configuredNumCtx;
    contextWindow;
    constructor(config = {}) {
        super(config);
        const rawUrl = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : '';
        let resolvedUrl = rawUrl || 'http://localhost:11434/api/chat';
        if (rawUrl) {
            try {
                const parsed = new URL(rawUrl);
                if (parsed.pathname === '' || parsed.pathname === '/') {
                    parsed.pathname = '/api/chat';
                    resolvedUrl = parsed.toString();
                }
            }
            catch {
                resolvedUrl = rawUrl;
            }
        }
        this.baseUrl = resolvedUrl;
        this.allowInsecureHttp = config.allowInsecureHttp === true;
        this.configuredNumCtx = parsePositiveCtx(config['numCtx']) ?? parsePositiveCtx(process.env.OLLAMA_NUM_CTX);
        this.contextWindow = this.configuredNumCtx ?? 16_384;
        this.model = String(canonicalModelId(config.model || DEFAULT_MODEL_BY_PROVIDER['ollama']) || '');
        this.visionModels = ['llava', 'vision', 'bakllava', 'moondream', 'minicpm-v', 'gemma3', 'qwen2.5vl', 'qwen3-vl'];
        this.audioModels = [];
        this.preserveReasoningContent = false;
    }
    async probeModelMeta(endpoint, headers, secrets, signal) {
        const origin = ollamaOriginUrl(endpoint);
        const cacheKey = `${origin}|${this.model}`;
        const cached = ollamaMetaCache.get(cacheKey);
        if (cached && Date.now() - cached.fetchedAt < OLLAMA_META_TTL_MS) {
            return cached;
        }
        try {
            const data = await safeProviderFetchJson({
                url: `${origin}/api/show`,
                method: 'POST',
                headers,
                body: JSON.stringify({ name: this.model }),
                signal,
                timeoutMs: 2_500,
                providerLabel: 'Ollama',
                secrets,
                hasApiKey: secrets.length > 0,
                allowInsecureHttp: this.allowInsecureHttp
            });
            let contextLength;
            if (data && typeof data['model_info'] === 'object' && data['model_info'] !== null) {
                for (const [key, val] of Object.entries(data['model_info'])) {
                    if (key.endsWith('.context_length') || key === 'context_length') {
                        const parsed = parsePositiveCtx(val);
                        if (parsed !== null) {
                            contextLength = parsed;
                            break;
                        }
                    }
                }
            }
            const caps = Array.isArray(data?.['capabilities'])
                ? data['capabilities'].map(c => String(c).toLowerCase())
                : [];
            const meta = {
                contextLength,
                supportsTools: caps.length > 0 ? caps.includes('tools') : undefined,
                supportsVision: caps.length > 0 ? caps.includes('vision') : undefined,
                fetchedAt: Date.now()
            };
            ollamaMetaCache.set(cacheKey, meta);
            return meta;
        }
        catch {
            const miss = { fetchedAt: Date.now() };
            ollamaMetaCache.set(cacheKey, miss);
            return null;
        }
    }
    normalizeImageBlocks(msg) {
        if (!Array.isArray(msg.content))
            return msg;
        const text = [];
        const images = [];
        for (const block of msg.content) {
            if (!block || typeof block !== 'object')
                continue;
            if (block.type === 'text' && typeof block.text === 'string') {
                text.push(block.text);
            }
            else if (block.type === 'image' && block.source?.type === 'base64') {
                images.push(block.source.data);
            }
            else if (block.type === 'image_url' && typeof block.image_url?.url === 'string') {
                const encoded = block.image_url.url.split('base64,')[1];
                if (encoded)
                    images.push(encoded);
            }
        }
        const normalized = { ...msg, content: text.join('\n') };
        if (images.length > 0)
            normalized['images'] = images;
        return normalized;
    }
    injectTextToolContracts(messages, tools) {
        if (!Array.isArray(tools) || tools.length === 0)
            return messages;
        const contracts = formatToolContracts(tools);
        const instruction = 'Native JSON tool calling is unavailable for this local model. ' +
            'To invoke a tool, output ONLY a JSON block wrapped in <tool_call> tags:\n' +
            '<tool_call>{"name": "tool_name", "arguments": { ... }}</tool_call>\n\n' +
            `Available Tools:\n${contracts}`;
        const cloned = messages.map(m => ({ ...m }));
        const firstSysIdx = cloned.findIndex(m => m?.role === 'system');
        if (firstSysIdx !== -1 && typeof cloned[firstSysIdx].content === 'string') {
            cloned[firstSysIdx].content = `${cloned[firstSysIdx].content}\n\n${instruction}`;
        }
        else {
            cloned.unshift({ role: 'system', content: instruction });
        }
        return cloned;
    }
    async chat(messages, options = {}) {
        const sanitizedMessages = normalizeMessagesForOllama(this.prepareMessages(messages));
        const endpoint = this.baseUrl || 'http://localhost:11434/api/chat';
        const origin = ollamaOriginUrl(endpoint);
        const cacheKey = `${origin}|${this.model}`;
        const trimmedKey = typeof this.apiKey === 'string' ? this.apiKey.trim() : '';
        const headers = { 'Content-Type': 'application/json' };
        if (trimmedKey)
            headers['Authorization'] = `Bearer ${trimmedKey}`;
        const secrets = trimmedKey ? [trimmedKey] : [];
        const meta = this.configuredNumCtx
            ? (ollamaMetaCache.get(cacheKey) ?? null)
            : await this.probeModelMeta(endpoint, headers, secrets, options.signal);
        const effectiveNumCtx = this.configuredNumCtx
            ?? (meta?.contextLength ? Math.min(meta.contextLength, 32_768) : 16_384);
        this.contextWindow = effectiveNumCtx;
        const ollamaOptions = {
            temperature: resolveTemperature(options.temperature, 0.1),
            num_ctx: effectiveNumCtx
        };
        if (typeof options.maxTokens === 'number' && Number.isFinite(options.maxTokens) && options.maxTokens >= 1) {
            ollamaOptions['num_predict'] = Math.floor(options.maxTokens);
        }
        const hasTools = Array.isArray(options.tools) && options.tools.length > 0;
        const skipNativeTools = meta?.supportsTools === false;
        let freeFormPaths = new Map();
        let adaptedTools;
        if (hasTools) {
            const scanReport = scanAndAdaptToolsForProvider(options.tools, 'ollama');
            adaptedTools = scanReport.adaptedTools;
            freeFormPaths = scanReport.freeFormPaths;
        }
        const buildPayload = (useNativeTools) => ({
            model: this.model,
            messages: !useNativeTools && hasTools
                ? this.injectTextToolContracts(sanitizedMessages, options.tools)
                : sanitizedMessages,
            stream: false,
            options: ollamaOptions,
            ...(useNativeTools && adaptedTools ? { tools: adaptedTools } : {}),
            ...(options.jsonMode ? { format: 'json' } : {})
        });
        const requestOpts = {
            url: endpoint,
            method: 'POST',
            headers,
            signal: options.signal,
            timeoutMs: options.timeoutMs,
            providerLabel: 'Ollama',
            secrets,
            hasApiKey: Boolean(trimmedKey),
            allowInsecureHttp: this.allowInsecureHttp
        };
        const runRequest = async (payload) => (wantsStreaming(options)
            ? await streamOllamaChat({
                ...requestOpts,
                payload,
                onChunk: options.onChunk,
                onReasoningChunk: options.onReasoningChunk
            })
            : await safeProviderFetchJson({
                ...requestOpts,
                body: JSON.stringify(payload)
            }));
        let data;
        const tryingNativeTools = hasTools && !skipNativeTools;
        try {
            data = await runRequest(buildPayload(tryingNativeTools));
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const status = err instanceof ProviderHttpError ? err.status : (typeof err?.status === 'number' ? err.status : null);
            if (tryingNativeTools && status === 400 && /does not support tools|tool[s ]+not supported|unknown field.*tools/i.test(msg)) {
                const existing = ollamaMetaCache.get(cacheKey);
                ollamaMetaCache.set(cacheKey, {
                    ...(existing ?? { fetchedAt: Date.now() }),
                    supportsTools: false,
                    fetchedAt: Date.now()
                });
                data = await runRequest(buildPayload(false));
            }
            else if (status === 404 && /model\b.*not found|pull/i.test(msg)) {
                throw new ProviderHttpError(`Ollama model "${this.model}" is not installed locally. Run \`ollama pull ${this.model}\` or select an installed model with /model.`, { status: 404 });
            }
            else {
                throw err;
            }
        }
        let content = typeof data['message']?.content === 'string' ? data['message'].content : '';
        const reasoningContent = typeof data['message']?.thinking === 'string' ? data['message'].thinking.trim() : '';
        let toolCalls = normalizeOpenAIToolCalls(data['message']?.tool_calls, freeFormPaths, 'call_ollama');
        if (toolCalls.length === 0 && content) {
            const extracted = extractTextToolCalls(content, 'call_ollama_text', freeFormPaths);
            if (extracted.length > 0) {
                toolCalls = extracted;
                content = stripToolCallMarkup(content).trim();
            }
        }
        const promptTokens = typeof data['prompt_eval_count'] === 'number' && Number.isFinite(data['prompt_eval_count']) && data['prompt_eval_count'] > 0
            ? data['prompt_eval_count']
            : 0;
        const completionTokens = typeof data['eval_count'] === 'number' && Number.isFinite(data['eval_count']) && data['eval_count'] > 0
            ? data['eval_count']
            : 0;
        return {
            content,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            ...(reasoningContent ? { reasoningContent } : {}),
            usage: {
                promptTokens,
                completionTokens,
                ...(promptTokens > 0 || completionTokens > 0 ? { measurement: 'provider_reported' } : {})
            }
        };
    }
}
