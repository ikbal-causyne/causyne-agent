/**
 * Causyne Agent — OpenRouter Free Provider
 *
 * Implements genuine zero-cost hosted model inference via the official
 * OpenRouter Free router (`openrouter/free`) and verified zero-cost models.
 * Enforces strict zero-cost boundaries, default data_collection: "deny",
 * streaming SSE, and safe tool-call parsing without paid model fallbacks.
 */
import { LLMProvider } from './base.js';
import { canonicalModelId } from '../modelIds.js';
import { scanAndAdaptToolsForProvider, normalizeToolName } from '../tools/toolScanner.js';
import { stripToolCallMarkup } from '../implementationPlan.js';
import { formatToolContracts } from './toolContracts.js';
import { extractTextToolCalls, normalizeOpenAIChatChoiceResponse, sanitizeProviderToolId, serializeAndDecodeArguments } from './wireNormalizer.js';
import { MAX_PROVIDER_ERROR_BYTES, MAX_PROVIDER_JSON_BYTES, MAX_SSE_BUFFER_BYTES, ProviderHttpError, parseRetryAfterMs, readBoundedResponseText, redactProviderSecrets, resolveTemperature, safeProviderFetch } from './byokHttp.js';
import { wantsStreaming } from './byokStream.js';
export const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
export const OPENROUTER_CHAT_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
export const OPENROUTER_DEFAULT_FREE_MODEL = 'openrouter/free';
export const OPENROUTER_FREE_FALLBACK_MODELS = [
    'openrouter/free',
    'qwen/qwen3-coder:free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'deepseek/deepseek-r1-0528:free'
];
export function parseRateLimitResetMs(headerValue, now = Date.now()) {
    if (typeof headerValue !== 'string')
        return undefined;
    const trimmed = headerValue.trim();
    if (!/^\d+(?:\.\d+)?$/.test(trimmed))
        return undefined;
    const raw = Number(trimmed);
    if (!Number.isFinite(raw) || raw <= 0)
        return undefined;
    const targetEpochMs = raw > 1e11 ? raw : (raw > 1e9 ? raw * 1000 : now + raw * 1000);
    const delta = Math.ceil(targetEpochMs - now);
    return Math.max(0, Math.min(delta, 300_000));
}
export class FreeModeCostGuardError extends Error {
    constructor(message) {
        super(message);
        this.name = 'FreeModeCostGuardError';
    }
}
export class OpenRouterRateLimitError extends Error {
    status = 429;
    retryAfterMs;
    constructor(message, retryAfterMs) {
        super(message);
        this.name = 'OpenRouterRateLimitError';
        this.retryAfterMs = retryAfterMs;
    }
}
export class OpenRouterPrivacyConstraintError extends Error {
    constructor(message) {
        super(message);
        this.name = 'OpenRouterPrivacyConstraintError';
    }
}
export class OpenRouterProvider extends LLMProvider {
    dataCollection;
    freeOnly;
    allowInsecureHttp;
    constructor(config = {}) {
        super(config);
        this.baseUrl = config['baseUrl'] || OPENROUTER_CHAT_ENDPOINT;
        this.allowInsecureHttp = config['allowInsecureHttp'] === true;
        this.model = canonicalModelId(String(config['model'] || OPENROUTER_DEFAULT_FREE_MODEL));
        this.dataCollection = config['openrouterDataCollection'] === 'allow' ? 'allow' : 'deny';
        this.freeOnly = config['freeOnly'] !== false; // Default: free mode enforced
        // Verify model cost constraint upon instantiation
        if (this.freeOnly) {
            this.assertFreeModel(this.model);
        }
    }
    /**
     * Determine whether a model identifier represents a zero-cost free route.
     */
    isFreeModel(modelId) {
        const clean = (modelId || '').trim().toLowerCase();
        if (!clean || /[\s?#\x00-\x1f]/.test(clean))
            return false;
        if (clean === 'openrouter/free' || clean === 'free')
            return true;
        if (clean.endsWith(':free')) {
            const slug = clean.slice(0, -5);
            return slug.length > 0 && !slug.startsWith('/') && !slug.endsWith('/');
        }
        return false;
    }
    /**
     * Enforce that the requested model is strictly zero-cost.
     */
    assertFreeModel(modelId) {
        if (!this.isFreeModel(modelId)) {
            throw new FreeModeCostGuardError(`Model '${modelId}' is not an authorized free model. Free mode strictly forbids paid models to prevent unintended charges.`);
        }
    }
    injectXmlToolContracts(messages, tools) {
        if (!Array.isArray(tools) || tools.length === 0)
            return messages;
        const contracts = formatToolContracts(tools);
        const instruction = 'Native JSON tool calling is unavailable on this free upstream endpoint. ' +
            'Invoke tools by outputting ONLY a JSON object wrapped in <tool_call> tags:\n' +
            '<tool_call>{"name": "tool_name", "arguments": { ... }}</tool_call>\n\n' +
            `Available Tools:\n${contracts}`;
        const cloned = messages.map(m => ({ ...m }));
        const sysIdx = cloned.findIndex(m => m?.role === 'system' && typeof m.content === 'string');
        if (sysIdx !== -1) {
            cloned[sysIdx].content = `${cloned[sysIdx].content}\n\n${instruction}`;
        }
        else {
            cloned.unshift({ role: 'system', content: instruction });
        }
        return cloned;
    }
    /**
     * Execute chat completion with OpenRouter, supporting streaming, tools, and privacy tags.
     */
    async chat(messages, options = {}) {
        if (this.freeOnly) {
            this.assertFreeModel(this.model);
        }
        const apiKey = String(this.apiKey || process.env.OPENROUTER_API_KEY || '').trim();
        if (!apiKey) {
            throw new Error('OpenRouter API key is required. Run /openrouter connect or /setup to connect your OpenRouter account.');
        }
        const supportsExplicitCacheControl = /^(?:anthropic\/|google\/gemini-)/i.test(this.model);
        const cacheAnchorIndices = new Set();
        for (let i = 0; i < messages.length; i++) {
            if (messages[i]?.cacheAnchor === true && messages[i]?.role === 'system') {
                cacheAnchorIndices.add(i);
            }
        }
        const basePrepared = this.prepareMessages(messages);
        const alignedByIndex = basePrepared.length === messages.length;
        const preparedMessages = basePrepared.map((msg, idx) => {
            if (supportsExplicitCacheControl
                && alignedByIndex
                && cacheAnchorIndices.has(idx)
                && msg?.role === 'system'
                && typeof msg.content === 'string'
                && msg.content.length >= 1024) {
                return {
                    ...msg,
                    content: [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }]
                };
            }
            return msg;
        });
        const shouldStream = wantsStreaming(options);
        const hasTools = Boolean(options.tools && Array.isArray(options.tools) && options.tools.length > 0);
        let adaptedTools;
        let freeFormPaths = new Map();
        if (hasTools) {
            const scanReport = scanAndAdaptToolsForProvider(options.tools, 'openai');
            adaptedTools = scanReport.adaptedTools;
            freeFormPaths = scanReport.freeFormPaths;
        }
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://causyne.com',
            'X-Title': 'Causyne Agent'
        };
        const endpoint = this.baseUrl || OPENROUTER_CHAT_ENDPOINT;
        const executeForModel = async (targetModel, useNativeTools) => {
            if (this.freeOnly) {
                this.assertFreeModel(targetModel);
            }
            const effectiveMessages = (!useNativeTools && hasTools)
                ? this.injectXmlToolContracts(preparedMessages, options.tools)
                : preparedMessages;
            const providerSpec = {
                data_collection: this.dataCollection
            };
            if (useNativeTools && adaptedTools) {
                providerSpec['require_parameters'] = true;
            }
            const payload = {
                model: targetModel,
                messages: effectiveMessages,
                temperature: resolveTemperature(options.temperature, 0.1),
                stream: shouldStream,
                ...(shouldStream ? { stream_options: { include_usage: true } } : {}),
                provider: providerSpec
            };
            if (typeof options.maxTokens === 'number' && Number.isFinite(options.maxTokens) && options.maxTokens >= 1) {
                payload['max_tokens'] = Math.floor(options.maxTokens);
            }
            if (options['jsonMode']) {
                payload['response_format'] = { type: 'json_object' };
            }
            if (useNativeTools && adaptedTools) {
                payload['tools'] = adaptedTools;
                payload['tool_choice'] = 'auto';
            }
            const { response, cleanup } = await safeProviderFetch({
                url: endpoint,
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                signal: options.signal,
                timeoutMs: typeof options['timeoutMs'] === 'number' ? options['timeoutMs'] : undefined,
                providerLabel: 'OpenRouter',
                secrets: [apiKey],
                hasApiKey: true,
                allowInsecureHttp: this.allowInsecureHttp
            });
            try {
                if (!response.ok) {
                    const rawError = await readBoundedResponseText(response, MAX_PROVIDER_ERROR_BYTES, {
                        truncate: true,
                        label: 'OpenRouter'
                    }).catch(() => '');
                    const cleanError = redactProviderSecrets(rawError, [apiKey]);
                    const hdrs = response.headers;
                    const retryAfterMs = parseRetryAfterMs(hdrs?.get?.('retry-after'))
                        ?? parseRateLimitResetMs(hdrs?.get?.('x-ratelimit-reset'));
                    this.handleHttpErrors(response.status, cleanError, retryAfterMs);
                }
                const contentType = (response.headers?.get?.('content-type') ?? '')
                    .split(';')[0]?.trim().toLowerCase() ?? '';
                const isJsonReply = contentType === 'application/json' || contentType.endsWith('+json');
                if (shouldStream && response.body && !isJsonReply) {
                    return await this.handleStreamingResponse(response, options, freeFormPaths, apiKey);
                }
                else {
                    const res = await this.handleJsonResponse(response, freeFormPaths, apiKey);
                    if (shouldStream) {
                        if (res.reasoningContent)
                            options.onReasoningChunk?.(res.reasoningContent);
                        if (res.content)
                            options.onChunk?.(res.content);
                    }
                    return res;
                }
            }
            finally {
                cleanup();
            }
        };
        const runWithToolFallback = async (targetModel) => {
            try {
                return await executeForModel(targetModel, hasTools);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                const status = err instanceof ProviderHttpError ? err.status : null;
                if (hasTools
                    && (status === 400 || status === 404)
                    && /(?:does not support tool|support tool use|tool[s ]+not supported|no endpoints found.*tool|require_parameters)/i.test(msg)) {
                    return await executeForModel(targetModel, false);
                }
                throw err;
            }
        };
        try {
            return await runWithToolFallback(this.model);
        }
        catch (primaryErr) {
            const isTransientFreeFailure = primaryErr instanceof OpenRouterRateLimitError
                || (primaryErr instanceof ProviderHttpError && (primaryErr.status === 429 || primaryErr.status === 502 || primaryErr.status === 503));
            const allowRotation = this.freeOnly && options['freeFallback'] !== false;
            if (!allowRotation || !isTransientFreeFailure || options.signal?.aborted) {
                throw primaryErr;
            }
            const candidates = OPENROUTER_FREE_FALLBACK_MODELS
                .filter(m => m.toLowerCase() !== this.model.toLowerCase() && this.isFreeModel(m))
                .slice(0, 2);
            for (const fallbackModel of candidates) {
                if (options.signal?.aborted)
                    break;
                try {
                    return await runWithToolFallback(fallbackModel);
                }
                catch {
                    // Try next zero-cost candidate; preserve original primaryErr if all fail
                }
            }
            throw primaryErr;
        }
    }
    /**
     * Map HTTP error codes into user-friendly and security-preserving exceptions.
     */
    handleHttpErrors(status, errorText, retryAfterMs) {
        if (status === 429) {
            const retryNote = retryAfterMs !== undefined
                ? ` Retry after ${Math.ceil(retryAfterMs / 1000)}s.`
                : '';
            throw new OpenRouterRateLimitError(`OpenRouter Free rate limit or quota exceeded. Free models have community concurrency limits. Please wait a moment or try again later.${retryNote}`, retryAfterMs);
        }
        const lowered = (errorText || '').toLowerCase();
        if (status === 400 || status === 404) {
            if (lowered.includes('data_collection') || lowered.includes('no provider available') || lowered.includes('data policy')) {
                throw new OpenRouterPrivacyConstraintError(`No free provider is currently available matching the privacy policy (data_collection='${this.dataCollection}'). ` +
                    `Free community models on OpenRouter typically require data collection. ` +
                    `Run "/openrouter allow" to permit free model routing, or inspect your preference with /openrouter status.`);
            }
            if (lowered.includes('rate limit') || lowered.includes('free model quota')) {
                throw new OpenRouterRateLimitError('OpenRouter Free usage limit reached for this free model. Please wait a moment or select another free model with /model.', retryAfterMs);
            }
        }
        throw new ProviderHttpError(`OpenRouter API Error (${status}): ${errorText}`, { status, retryAfterMs });
    }
    /**
     * Process a non-streaming JSON response from OpenRouter.
     */
    async handleJsonResponse(response, freeFormPaths, apiKey) {
        let data;
        if (!response.body && typeof response.text !== 'function' && typeof response.json === 'function') {
            data = await response.json();
        }
        else {
            const rawText = await readBoundedResponseText(response, MAX_PROVIDER_JSON_BYTES, {
                truncate: false,
                label: 'OpenRouter'
            });
            const cleanText = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;
            try {
                data = JSON.parse(cleanText);
            }
            catch {
                const preview = redactProviderSecrets(rawText.slice(0, 240), [apiKey]);
                throw new Error(`OpenRouter returned a non-JSON response (HTTP ${response.status}): ${preview}`);
            }
        }
        if (data && typeof data === 'object' && data.error && typeof data.error === 'object') {
            const rawErr = typeof data.error.message === 'string' ? data.error.message : JSON.stringify(data.error);
            const cleanErr = redactProviderSecrets(rawErr, [apiKey]);
            const rawCode = data.error.code;
            const numericCode = typeof rawCode === 'number'
                ? rawCode
                : (typeof rawCode === 'string' && /^\d{3}$/.test(rawCode.trim())
                    ? Number(rawCode.trim())
                    : (typeof rawCode === 'string' && /rate.?limit/i.test(rawCode) ? 429 : 502));
            this.handleHttpErrors(numericCode, cleanErr);
        }
        const normalized = normalizeOpenAIChatChoiceResponse(data, {
            prefix: 'call_openrouter',
            ...(freeFormPaths ? { freeFormPaths } : {})
        });
        const usage = this.normalizeUsage(normalized.rawUsage);
        return {
            content: normalized.content,
            toolCalls: normalized.toolCalls,
            reasoningContent: normalized.reasoningContent,
            usage
        };
    }
    /**
     * Process a streaming SSE response from OpenRouter.
     */
    async handleStreamingResponse(response, options, freeFormPaths, apiKey) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let content = '';
        let reasoningContent = '';
        let buffer = '';
        let totalBytes = 0;
        const toolCallsMap = new Map();
        let rawUsage = null;
        const processLine = (line) => {
            const stripped = line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
            const trimmed = stripped.trim();
            if (!trimmed || trimmed.startsWith(':'))
                return; // Skip comments/keepalive
            if (trimmed === 'data: [DONE]' || trimmed === 'data:[DONE]')
                return;
            if (trimmed.startsWith('data:')) {
                const jsonStr = trimmed.slice(5).replace(/^ /, '');
                let parsed;
                try {
                    parsed = JSON.parse(jsonStr);
                }
                catch {
                    return;
                }
                if (!parsed || typeof parsed !== 'object')
                    return;
                if (parsed.error && typeof parsed.error === 'object') {
                    const rawErr = typeof parsed.error.message === 'string' ? parsed.error.message : JSON.stringify(parsed.error);
                    const cleanErr = redactProviderSecrets(rawErr, [apiKey]);
                    const rawCode = parsed.error.code;
                    const numericCode = typeof rawCode === 'number'
                        ? rawCode
                        : (typeof rawCode === 'string' && /^\d{3}$/.test(rawCode.trim())
                            ? Number(rawCode.trim())
                            : (typeof rawCode === 'string' && /rate.?limit/i.test(rawCode) ? 429 : 502));
                    this.handleHttpErrors(numericCode, cleanErr);
                }
                if (parsed.usage) {
                    rawUsage = parsed.usage;
                }
                const choice = parsed.choices?.[0];
                if (!choice)
                    return;
                const delta = choice.delta;
                if (delta) {
                    // 1. Text chunk
                    if (delta.content) {
                        content += delta.content;
                        if (options.onChunk) {
                            options.onChunk(delta.content);
                        }
                    }
                    // 2. Reasoning chunk (supports reasoning, reasoning_content, and OpenRouter reasoning_details[])
                    let reasoning = '';
                    if (typeof delta.reasoning === 'string')
                        reasoning += delta.reasoning;
                    else if (typeof delta.reasoning_content === 'string')
                        reasoning += delta.reasoning_content;
                    if (!reasoning && Array.isArray(delta.reasoning_details)) {
                        for (const detail of delta.reasoning_details) {
                            if (detail && typeof detail === 'object' && typeof detail.text === 'string') {
                                reasoning += detail.text;
                            }
                            else if (detail && typeof detail === 'object' && typeof detail.summary === 'string') {
                                reasoning += detail.summary;
                            }
                        }
                    }
                    if (reasoning) {
                        reasoningContent += reasoning;
                        if (options.onReasoningChunk) {
                            options.onReasoningChunk(reasoning);
                        }
                    }
                    // 3. Tool calls assembly (handles providers that omit tc.index on argument continuation chunks)
                    if (Array.isArray(delta.tool_calls)) {
                        for (const tc of delta.tool_calls) {
                            if (!tc || typeof tc !== 'object')
                                continue;
                            let idx;
                            if (typeof tc.index === 'number' && Number.isInteger(tc.index) && tc.index >= 0) {
                                idx = tc.index;
                            }
                            else if (typeof tc.id === 'string' && tc.id) {
                                const matchedEntry = [...toolCallsMap.entries()].find(([, entry]) => entry.id === tc.id);
                                idx = matchedEntry ? matchedEntry[0] : (Math.max(-1, ...toolCallsMap.keys()) + 1);
                            }
                            else if (!tc.function?.name && toolCallsMap.size > 0) {
                                idx = Math.max(...toolCallsMap.keys());
                            }
                            else {
                                idx = Math.max(-1, ...toolCallsMap.keys()) + 1;
                            }
                            let existing = toolCallsMap.get(idx);
                            if (!existing) {
                                existing = { id: sanitizeProviderToolId(tc.id, 'call_openrouter', idx), name: '', arguments: '' };
                                toolCallsMap.set(idx, existing);
                            }
                            if (typeof tc.id === 'string' && tc.id)
                                existing.id = sanitizeProviderToolId(tc.id, 'call_openrouter', idx);
                            if (typeof tc.function?.name === 'string')
                                existing.name += tc.function.name;
                            if (typeof tc.function?.arguments === 'string')
                                existing.arguments += tc.function.arguments;
                        }
                    }
                }
            }
        };
        try {
            while (true) {
                if (options.signal?.aborted) {
                    await reader.cancel().catch(() => { });
                    const abortErr = new Error('OpenRouter request aborted');
                    abortErr.name = 'AbortError';
                    throw abortErr;
                }
                const { done, value } = await reader.read();
                if (done)
                    break;
                if (!value)
                    continue;
                totalBytes += value.byteLength;
                if (totalBytes > MAX_PROVIDER_JSON_BYTES) {
                    await reader.cancel().catch(() => { });
                    throw new Error(`OpenRouter stream exceeded maximum allowed size (${MAX_PROVIDER_JSON_BYTES} bytes).`);
                }
                buffer += decoder.decode(value, { stream: true });
                if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_BUFFER_BYTES) {
                    await reader.cancel().catch(() => { });
                    throw new Error(`OpenRouter SSE buffer exceeded maximum allowed size (${MAX_SSE_BUFFER_BYTES} bytes).`);
                }
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    processLine(line);
                }
            }
            buffer += decoder.decode();
            if (buffer.trim()) {
                for (const line of buffer.split('\n')) {
                    processLine(line);
                }
            }
        }
        finally {
            reader.releaseLock();
        }
        const toolCalls = [];
        const sortedItems = [...toolCallsMap.entries()].sort((a, b) => a[0] - b[0]);
        for (const [idx, item] of sortedItems) {
            if (item.name) {
                const cleanName = normalizeToolName(item.name);
                if (!cleanName)
                    continue;
                toolCalls.push({
                    id: sanitizeProviderToolId(item.id, 'call_openrouter', idx),
                    type: 'function',
                    function: {
                        name: cleanName,
                        arguments: serializeAndDecodeArguments(item.arguments || '{}', cleanName, freeFormPaths)
                    }
                });
            }
        }
        if (toolCalls.length === 0 && content) {
            const extracted = extractTextToolCalls(content, 'call_openrouter_text', freeFormPaths);
            if (extracted.length > 0) {
                toolCalls.push(...extracted);
                content = stripToolCallMarkup(content).trim();
            }
        }
        const usage = this.normalizeUsage(rawUsage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
        return {
            content,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            reasoningContent: reasoningContent || undefined,
            usage
        };
    }
}
