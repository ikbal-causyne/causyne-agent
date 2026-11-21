import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { LLMProvider } from './base.js';
import { scanAndAdaptToolsForProvider, normalizeToolName } from '../tools/toolScanner.js';
import { prepareMessagesForAnthropic, safeParseJsonObject, sanitizeProviderToolId, serializeAndDecodeArguments } from './wireNormalizer.js';
import { requireApiKey, resolveTemperature, safeProviderFetchJson } from './byokHttp.js';
import { streamAnthropicMessages, wantsStreaming } from './byokStream.js';
const TOOL_SEARCH_MODELS = [
    'claude-3-7-sonnet',
    'claude-3-5-sonnet',
    'claude-3-5-haiku',
    'claude-3-opus',
    'claude-fable-5',
    'claude-mythos-5',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-opus-4-5',
    'claude-sonnet-4-5',
    'claude-haiku-4-5'
];
const NO_SAMPLING_MODELS = [
    'claude-fable-5',
    'claude-mythos-5',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-sonnet-5'
];
const MID_CONVERSATION_SYSTEM_MODELS = [
    'claude-fable-5',
    'claude-mythos-5',
    'claude-opus-5',
    'claude-opus-4-8'
];
const ADAPTIVE_THINKING_MODELS = [
    'claude-fable-5',
    'claude-mythos-5',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-5',
    'claude-sonnet-4-6'
];
const THINKS_BY_DEFAULT_MODELS = [
    'claude-fable-5',
    'claude-mythos-5',
    'claude-opus-5'
];
const THINKING_ALWAYS_ON_MODELS = [
    'claude-fable-5',
    'claude-mythos-5'
];
const EFFORT_MODELS = [...ADAPTIVE_THINKING_MODELS, 'claude-opus-4-5'];
const LIMITED_EFFORT_MODELS = ['claude-opus-4-5', 'claude-opus-4-6', 'claude-sonnet-4-6'];
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
function modelMatches(model, list) {
    const normalized = (model || '').toLowerCase();
    return list.some(supported => normalized.startsWith(supported));
}
export class AnthropicProvider extends LLMProvider {
    enableToolSearch;
    enableCaching;
    cacheTtl;
    reasoningEffort;
    showReasoning;
    reasoningBudgetTokens;
    constructor(config = {}) {
        super(config);
        this.baseUrl = 'https://api.anthropic.com/v1/messages';
        this.model = String(canonicalModelId(config.model || DEFAULT_MODEL_BY_PROVIDER['anthropic']) || '');
        this.visionModels = ['*'];
        this.audioModels = [];
        this.imagePayloadFormat = 'anthropic';
        this.enableToolSearch = config.enableToolSearch !== false;
        this.enableCaching = config.enablePromptCaching !== false;
        this.cacheTtl = config.promptCacheTtl || '1h';
        this.reasoningEffort = config.reasoningEffort || null;
        this.showReasoning = config.showReasoning === true;
        this.reasoningBudgetTokens = typeof config.reasoningBudgetTokens === 'number' ? config.reasoningBudgetTokens : null;
    }
    cacheControl() {
        return this.cacheTtl === '5m'
            ? { type: 'ephemeral' }
            : { type: 'ephemeral', ttl: this.cacheTtl };
    }
    supportsToolSearch() {
        if (!this.enableToolSearch)
            return false;
        return modelMatches(this.model, TOOL_SEARCH_MODELS);
    }
    rejectsSamplingParameters() {
        return modelMatches(this.model, NO_SAMPLING_MODELS);
    }
    supportsAdaptiveThinking() {
        return modelMatches(this.model, ADAPTIVE_THINKING_MODELS);
    }
    resolveEffort() {
        if (!modelMatches(this.model, EFFORT_MODELS))
            return null;
        const requested = String(this.reasoningEffort || '').toLowerCase();
        if (!EFFORT_LEVELS.includes(requested))
            return null;
        if (modelMatches(this.model, LIMITED_EFFORT_MODELS) && (requested === 'xhigh' || requested === 'max')) {
            return 'high';
        }
        return requested;
    }
    buildThinking() {
        if (modelMatches(this.model, THINKING_ALWAYS_ON_MODELS))
            return null;
        if (this.reasoningEffort === 'off') {
            if (!modelMatches(this.model, THINKS_BY_DEFAULT_MODELS))
                return null;
            const effort = this.resolveEffort();
            if (effort === 'xhigh' || effort === 'max')
                return null;
            return { type: 'disabled' };
        }
        if (this.supportsAdaptiveThinking()) {
            const thinking = { type: 'adaptive' };
            if (this.showReasoning)
                thinking['display'] = 'summarized';
            return thinking;
        }
        if (this.reasoningBudgetTokens) {
            return { type: 'enabled', budget_tokens: this.reasoningBudgetTokens };
        }
        return null;
    }
    supportsMidConversationSystem() {
        return modelMatches(this.model, MID_CONVERSATION_SYSTEM_MODELS);
    }
    async chat(messages, options = {}) {
        messages = prepareMessagesForAnthropic(this, messages);
        const systemBlocks = [];
        const anthropicMessages = [];
        const MAX_SYSTEM_CACHE_BREAKPOINTS = 3;
        let systemCacheBreakpoints = 0;
        const allowInlineSystem = this.supportsMidConversationSystem();
        for (const msg of messages) {
            if (msg.role === 'system') {
                const isMidConversation = anthropicMessages.length > 0;
                const lastEmitted = anthropicMessages[anthropicMessages.length - 1];
                if (isMidConversation && allowInlineSystem && lastEmitted?.['role'] === 'user') {
                    anthropicMessages.push({ role: 'system', content: String(msg.content ?? '') });
                    continue;
                }
                const sysText = String(msg.content ?? '');
                if (!sysText.trim())
                    continue;
                const block = { type: 'text', text: sysText };
                if (msg.cacheAnchor && this.enableCaching && systemCacheBreakpoints < MAX_SYSTEM_CACHE_BREAKPOINTS) {
                    block['cache_control'] = this.cacheControl();
                    systemCacheBreakpoints++;
                }
                systemBlocks.push(block);
            }
            else if (msg.role === 'tool') {
                let toolContent = msg.content ?? '';
                if (typeof toolContent !== 'string' && !Array.isArray(toolContent)) {
                    try {
                        toolContent = JSON.stringify(toolContent);
                    }
                    catch {
                        toolContent = String(toolContent);
                    }
                }
                const toolResultBlock = {
                    type: 'tool_result',
                    tool_use_id: sanitizeProviderToolId(msg.tool_call_id, 'toolu', 0),
                    content: toolContent
                };
                const lastMsg = anthropicMessages[anthropicMessages.length - 1];
                if (lastMsg && lastMsg['role'] === 'user' && Array.isArray(lastMsg['content']) && lastMsg['content'][0]?.type === 'tool_result') {
                    lastMsg['content'].push(toolResultBlock);
                }
                else {
                    anthropicMessages.push({ role: 'user', content: [toolResultBlock] });
                }
            }
            else if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                const contentBlocks = [];
                if (Array.isArray(msg.thinking_blocks)) {
                    contentBlocks.push(...msg.thinking_blocks);
                }
                if (typeof msg.content === 'string' && msg.content.length > 0) {
                    contentBlocks.push({ type: 'text', text: msg.content });
                }
                for (let idx = 0; idx < msg.tool_calls.length; idx++) {
                    const tc = msg.tool_calls[idx];
                    if (!tc || typeof tc !== 'object')
                        continue;
                    const toolName = normalizeToolName(tc.function?.name || '');
                    if (!toolName)
                        continue;
                    contentBlocks.push({
                        type: 'tool_use',
                        id: sanitizeProviderToolId(tc.id, 'toolu', idx),
                        name: toolName,
                        input: safeParseJsonObject(tc.function?.arguments)
                    });
                }
                if (contentBlocks.length > 0) {
                    anthropicMessages.push({ role: 'assistant', content: contentBlocks });
                }
            }
            else {
                const { cacheAnchor: _c, thinking_blocks: _tb, reasoning_content: _rc, spillPath: _sp, ...clean } = msg;
                const nextContent = clean.content ?? '';
                const prev = anthropicMessages[anthropicMessages.length - 1];
                if (clean.role === 'user' && prev && prev['role'] === 'user') {
                    const prevBlocks = Array.isArray(prev['content'])
                        ? prev['content']
                        : (typeof prev['content'] === 'string' && prev['content'] ? [{ type: 'text', text: prev['content'] }] : []);
                    const nextBlocks = Array.isArray(nextContent)
                        ? nextContent
                        : (typeof nextContent === 'string' && nextContent ? [{ type: 'text', text: nextContent }] : []);
                    prev['content'] = [...prevBlocks, ...nextBlocks];
                }
                else {
                    anthropicMessages.push({ ...clean, content: nextContent });
                }
            }
        }
        const apiKey = requireApiKey(this.apiKey, 'Anthropic');
        const payload = {
            model: this.model,
            ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
            messages: anthropicMessages,
            max_tokens: typeof options.maxTokens === 'number' && Number.isFinite(options.maxTokens) && options.maxTokens >= 1
                ? Math.floor(options.maxTokens)
                : 16000
        };
        const thinking = this.buildThinking();
        const thinkingActive = Boolean(thinking && thinking['type'] !== 'disabled');
        if (!this.rejectsSamplingParameters() && !thinkingActive) {
            payload['temperature'] = resolveTemperature(options.temperature, 0.1);
        }
        if (thinking) {
            if (thinking['type'] === 'enabled' && typeof thinking['budget_tokens'] === 'number' && Number.isFinite(thinking['budget_tokens'])) {
                if (payload['max_tokens'] <= 1024)
                    payload['max_tokens'] = 2048;
                thinking['budget_tokens'] = Math.max(1024, Math.min(Math.floor(thinking['budget_tokens']), payload['max_tokens'] - 1));
            }
            payload['thinking'] = thinking;
        }
        const effort = this.resolveEffort();
        if (effort)
            payload['output_config'] = { ...(payload['output_config'] || {}), effort };
        let freeFormPaths = new Map();
        if (options.tools && options.tools.length > 0) {
            const useToolSearch = this.supportsToolSearch();
            const coreToolCount = Number.isInteger(options.coreToolCount) ? options.coreToolCount : options.tools.length;
            const scanReport = scanAndAdaptToolsForProvider(options.tools, 'anthropic', {
                useToolSearch,
                coreToolCount
            });
            const converted = scanReport.adaptedTools;
            freeFormPaths = scanReport.freeFormPaths;
            if (useToolSearch) {
                payload['tools'] = [
                    { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' },
                    ...converted
                ];
            }
            else {
                payload['tools'] = converted;
            }
            if (this.enableCaching) {
                const anchorIndex = useToolSearch
                    ? Math.min(coreToolCount, payload['tools'].length - 1)
                    : payload['tools'].length - 1;
                const anchor = payload['tools'][anchorIndex];
                if (anchor && !anchor.defer_loading && !anchor.type) {
                    anchor.cache_control = this.cacheControl();
                }
            }
        }
        const endpoint = this.baseUrl || 'https://api.anthropic.com/v1/messages';
        const requestOpts = {
            url: endpoint,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            signal: options.signal,
            timeoutMs: options.timeoutMs,
            providerLabel: 'Anthropic',
            secrets: [apiKey],
            hasApiKey: true
        };
        const data = wantsStreaming(options)
            ? await streamAnthropicMessages({
                ...requestOpts,
                payload,
                onChunk: options.onChunk,
                onReasoningChunk: options.onReasoningChunk
            })
            : await safeProviderFetchJson({
                ...requestOpts,
                body: JSON.stringify(payload)
            });
        let content = '';
        const toolCalls = [];
        const thinkingBlocks = [];
        let reasoningContent = '';
        for (const block of (Array.isArray(data['content']) ? data['content'] : [])) {
            if (block.type === 'thinking' || block.type === 'redacted_thinking') {
                thinkingBlocks.push(block);
                if (typeof block.thinking === 'string')
                    reasoningContent += block.thinking;
            }
            else if (block.type === 'text') {
                content += block.text || '';
            }
            else if (block.type === 'tool_use') {
                const callName = normalizeToolName(block.name || '');
                toolCalls.push({
                    id: sanitizeProviderToolId(block.id, 'toolu', toolCalls.length),
                    type: 'function',
                    function: {
                        name: callName,
                        arguments: serializeAndDecodeArguments(block.input || {}, callName, freeFormPaths)
                    }
                });
            }
        }
        const rawUsage = data['usage'];
        return {
            content: content.trim(),
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            thinkingBlocks: thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
            reasoningContent: reasoningContent.trim() || undefined,
            usage: {
                promptTokens: (rawUsage?.input_tokens || 0) +
                    (rawUsage?.cache_read_input_tokens || 0) +
                    (rawUsage?.cache_creation_input_tokens || 0),
                completionTokens: rawUsage?.output_tokens || 0,
                cachedPromptTokens: rawUsage?.cache_read_input_tokens || 0,
                cacheWriteMultiplier: this.cacheTtl === '5m' ? 1.25 : 2.0,
                cacheWriteTokens: rawUsage?.cache_creation_input_tokens || 0
            }
        };
    }
}
