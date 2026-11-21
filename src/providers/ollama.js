import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { LLMProvider } from './base.js';
import { scanAndAdaptToolsForProvider } from '../tools/toolScanner.js';
import { normalizeMessagesForOllama, normalizeOpenAIToolCalls, extractTextToolCalls } from './wireNormalizer.js';
import { stripToolCallMarkup } from '../implementationPlan.js';
import { resolveTemperature, safeProviderFetchJson } from './byokHttp.js';
import { streamOllamaChat, wantsStreaming } from './byokStream.js';
export class OllamaProvider extends LLMProvider {
    allowInsecureHttp;
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
        this.model = String(canonicalModelId(config.model || DEFAULT_MODEL_BY_PROVIDER['ollama']) || '');
        this.visionModels = ['llava', 'vision', 'bakllava', 'moondream', 'minicpm-v', 'gemma3', 'qwen2.5vl', 'qwen3-vl'];
        this.audioModels = [];
    }
    normalizeImageBlocks(msg) {
        if (!Array.isArray(msg.content))
            return msg;
        const text = [];
        const images = [];
        for (const block of msg.content) {
            if (block.type === 'text') {
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
    async chat(messages, options = {}) {
        const sanitizedMessages = normalizeMessagesForOllama(this.prepareMessages(messages));
        const ollamaOptions = {
            temperature: resolveTemperature(options.temperature, 0.1)
        };
        if (typeof options.maxTokens === 'number' && Number.isFinite(options.maxTokens) && options.maxTokens >= 1) {
            ollamaOptions['num_predict'] = Math.floor(options.maxTokens);
        }
        const payload = {
            model: this.model,
            messages: sanitizedMessages,
            stream: false,
            options: ollamaOptions,
            ...(options.jsonMode ? { format: 'json' } : {})
        };
        let freeFormPaths = new Map();
        if (options.tools && options.tools.length > 0) {
            const scanReport = scanAndAdaptToolsForProvider(options.tools, 'ollama');
            payload['tools'] = scanReport.adaptedTools;
            freeFormPaths = scanReport.freeFormPaths;
        }
        const endpoint = this.baseUrl || 'http://localhost:11434/api/chat';
        const requestOpts = {
            url: endpoint,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: options.signal,
            timeoutMs: options.timeoutMs,
            providerLabel: 'Ollama',
            hasApiKey: false,
            allowInsecureHttp: this.allowInsecureHttp
        };
        const data = wantsStreaming(options)
            ? await streamOllamaChat({
                ...requestOpts,
                payload,
                onChunk: options.onChunk,
                onReasoningChunk: options.onReasoningChunk
            })
            : await safeProviderFetchJson({
                ...requestOpts,
                body: JSON.stringify(payload)
            });
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
        return {
            content,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            ...(reasoningContent ? { reasoningContent } : {}),
            usage: {
                promptTokens: data['prompt_eval_count'] || 0,
                completionTokens: data['eval_count'] || 0
            }
        };
    }
}
