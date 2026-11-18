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
import { scanAndAdaptToolsForProvider } from '../tools/toolScanner.js';
import { extractTextToolCalls, normalizeOpenAIChatChoiceResponse, serializeAndDecodeArguments } from './wireNormalizer.js';
import { normalizeToolName } from '../tools/toolScanner.js';
export const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
export const OPENROUTER_CHAT_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
export const OPENROUTER_DEFAULT_FREE_MODEL = 'openrouter/free';
export class FreeModeCostGuardError extends Error {
    constructor(message) {
        super(message);
        this.name = 'FreeModeCostGuardError';
    }
}
export class OpenRouterRateLimitError extends Error {
    constructor(message) {
        super(message);
        this.name = 'OpenRouterRateLimitError';
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
    constructor(config = {}) {
        super(config);
        this.baseUrl = config['baseUrl'] || OPENROUTER_CHAT_ENDPOINT;
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
        if (clean === 'openrouter/free' || clean === 'free')
            return true;
        if (clean.endsWith(':free'))
            return true;
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
    /**
     * Execute chat completion with OpenRouter, supporting streaming, tools, and privacy tags.
     */
    async chat(messages, options = {}) {
        if (this.freeOnly) {
            this.assertFreeModel(this.model);
        }
        const apiKey = this.apiKey || process.env.OPENROUTER_API_KEY;
        if (!apiKey) {
            throw new Error('OpenRouter API key is required. Run /openrouter connect or /setup to connect your OpenRouter account.');
        }
        const preparedMessages = this.prepareMessages(messages);
        const shouldStream = typeof options.onChunk === 'function';
        const payload = {
            model: this.model,
            messages: preparedMessages,
            temperature: options.temperature ?? 0.1,
            stream: shouldStream,
            provider: {
                data_collection: this.dataCollection
            }
        };
        if (options['jsonMode']) {
            payload['response_format'] = { type: 'json_object' };
        }
        let freeFormPaths = new Map();
        if (options.tools && Array.isArray(options.tools) && options.tools.length > 0) {
            const scanReport = scanAndAdaptToolsForProvider(options.tools, 'openai');
            payload['tools'] = scanReport.adaptedTools;
            payload['tool_choice'] = 'auto';
            freeFormPaths = scanReport.freeFormPaths;
        }
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://causyne.com',
            'X-Title': 'Causyne Agent'
        };
        let response;
        const endpoint = this.baseUrl || OPENROUTER_CHAT_ENDPOINT;
        const fetchInit = {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
        };
        if (options.signal) {
            fetchInit.signal = options.signal;
        }
        try {
            response = await fetch(endpoint, fetchInit);
        }
        catch (err) {
            if (err?.name === 'AbortError' || options.signal?.aborted) {
                throw err;
            }
            throw new Error(`OpenRouter network connection error: ${err?.message || err}`);
        }
        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            this.handleHttpErrors(response.status, errorText);
        }
        if (shouldStream && response.body) {
            return this.handleStreamingResponse(response, options, freeFormPaths);
        }
        else {
            return this.handleJsonResponse(response, freeFormPaths);
        }
    }
    /**
     * Map HTTP error codes into user-friendly and security-preserving exceptions.
     */
    handleHttpErrors(status, errorText) {
        if (status === 429) {
            throw new OpenRouterRateLimitError('OpenRouter Free rate limit or quota exceeded. Free models have community concurrency limits. Please wait a moment or try again later.');
        }
        const lowered = (errorText || '').toLowerCase();
        if (status === 400 || status === 404) {
            if (lowered.includes('data_collection') || lowered.includes('no provider available') || lowered.includes('data policy')) {
                throw new OpenRouterPrivacyConstraintError(`No free provider is currently available matching the privacy policy (data_collection='${this.dataCollection}'). ` +
                    `Free community models on OpenRouter typically require data collection. ` +
                    `Run "/openrouter allow" to permit free model routing, or inspect your preference with /openrouter status.`);
            }
            if (lowered.includes('rate limit') || lowered.includes('free model quota')) {
                throw new OpenRouterRateLimitError('OpenRouter Free usage limit reached for this free model. Please wait a moment or select another free model with /model.');
            }
        }
        throw new Error(`OpenRouter API Error (${status}): ${errorText}`);
    }
    /**
     * Process a non-streaming JSON response from OpenRouter.
     */
    async handleJsonResponse(response, freeFormPaths) {
        const data = (await response.json());
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
    async handleStreamingResponse(response, options, freeFormPaths) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let content = '';
        let reasoningContent = '';
        let buffer = '';
        const toolCallsMap = new Map();
        let rawUsage = null;
        try {
            while (true) {
                if (options.signal?.aborted) {
                    await reader.cancel().catch(() => { });
                    break;
                }
                const { done, value } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith(':'))
                        continue; // Skip comments/keepalive
                    if (trimmed === 'data: [DONE]')
                        continue;
                    if (trimmed.startsWith('data: ')) {
                        const jsonStr = trimmed.slice(6);
                        let parsed;
                        try {
                            parsed = JSON.parse(jsonStr);
                        }
                        catch {
                            continue;
                        }
                        if (parsed.usage) {
                            rawUsage = parsed.usage;
                        }
                        const choice = parsed.choices?.[0];
                        if (!choice)
                            continue;
                        const delta = choice.delta;
                        if (delta) {
                            // 1. Text chunk
                            if (delta.content) {
                                content += delta.content;
                                if (options.onChunk) {
                                    options.onChunk(delta.content);
                                }
                            }
                            // 2. Reasoning chunk
                            const reasoning = delta.reasoning || delta.reasoning_content;
                            if (reasoning) {
                                reasoningContent += reasoning;
                                if (options.onReasoningChunk) {
                                    options.onReasoningChunk(reasoning);
                                }
                            }
                            // 3. Tool calls assembly
                            if (Array.isArray(delta.tool_calls)) {
                                for (const tc of delta.tool_calls) {
                                    const idx = typeof tc.index === 'number' ? tc.index : toolCallsMap.size;
                                    let existing = toolCallsMap.get(idx);
                                    if (!existing) {
                                        existing = { id: tc.id || `call_${idx}_${Date.now()}`, name: '', arguments: '' };
                                        toolCallsMap.set(idx, existing);
                                    }
                                    if (tc.id)
                                        existing.id = tc.id;
                                    if (tc.function?.name)
                                        existing.name += tc.function.name;
                                    if (tc.function?.arguments)
                                        existing.arguments += tc.function.arguments;
                                }
                            }
                        }
                    }
                }
            }
        }
        finally {
            reader.releaseLock();
        }
        const toolCalls = [];
        for (const item of toolCallsMap.values()) {
            if (item.name) {
                const cleanName = normalizeToolName(item.name);
                toolCalls.push({
                    id: item.id,
                    type: 'function',
                    function: {
                        name: cleanName,
                        arguments: serializeAndDecodeArguments(item.arguments || '{}', cleanName, freeFormPaths)
                    }
                });
            }
        }
        if (toolCalls.length === 0 && content) {
            const extracted = extractTextToolCalls(content, 'call_text', freeFormPaths);
            if (extracted.length > 0) {
                toolCalls.push(...extracted);
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
