import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { LLMProvider, mimeTypeForAudioFormat } from './base.js';
import { scanAndAdaptToolsForProvider, adaptSchemaForGemini, isEmptyObjectSchema, normalizeToolName } from '../tools/toolScanner.js';
import { safeParseJsonObject, sanitizeProviderToolId, serializeAndDecodeArguments } from './wireNormalizer.js';
import { requireApiKey, resolveTemperature, safeProviderFetchJson } from './byokHttp.js';
import { streamGeminiGenerateContent, wantsStreaming } from './byokStream.js';
export { adaptSchemaForGemini, isEmptyObjectSchema };
export function geminiUsageToOpenAIShape(usageMetadata) {
    const nonNeg = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
    const prompt = nonNeg(usageMetadata?.['promptTokenCount']);
    const candidates = nonNeg(usageMetadata?.['candidatesTokenCount']);
    const thoughts = nonNeg(usageMetadata?.['thoughtsTokenCount']);
    const total = nonNeg(usageMetadata?.['totalTokenCount']);
    const cached = nonNeg(usageMetadata?.['cachedContentTokenCount']);
    const completion = total > prompt ? total - prompt : candidates + thoughts;
    return {
        prompt_tokens: prompt,
        completion_tokens: completion,
        prompt_tokens_details: { cached_tokens: cached }
    };
}
export class GeminiProvider extends LLMProvider {
    allowInsecureHttp;
    constructor(config = {}) {
        super(config);
        this.model = String(canonicalModelId(config.model || DEFAULT_MODEL_BY_PROVIDER['gemini']) || '');
        this.allowInsecureHttp = config.allowInsecureHttp === true;
        const customUrl = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : '';
        if (customUrl) {
            try {
                const parsed = new URL(customUrl);
                parsed.searchParams.delete('key');
                this.baseUrl = parsed.toString();
            }
            catch {
                this.baseUrl = customUrl;
            }
        }
        else {
            this.baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
        }
        this.visionModels = ['gemini-'];
        this.imagePayloadFormat = 'gemini';
        this.audioModels = ['gemini-'];
        this.audioPayloadFormat = 'gemini';
        this.preserveReasoningContent = false;
    }
    async chat(messages, options = {}) {
        messages = this.prepareMessages(messages);
        const systemParts = [];
        const contents = [];
        const toolNameById = new Map();
        for (const msg of messages) {
            if (msg.role === 'system') {
                const text = typeof msg.content === 'string'
                    ? msg.content
                    : JSON.stringify(msg.content);
                if (text)
                    systemParts.push({ text });
                continue;
            }
            const role = msg.role === 'assistant' ? 'model' : 'user';
            if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                const parts = [];
                if (typeof msg.content === 'string' && msg.content)
                    parts.push({ text: msg.content });
                for (const tc of msg.tool_calls) {
                    if (!tc || typeof tc !== 'object')
                        continue;
                    const normalizedName = normalizeToolName(tc.function?.name || '');
                    if (!normalizedName)
                        continue;
                    if (typeof tc.id === 'string' && tc.id)
                        toolNameById.set(tc.id, normalizedName);
                    const fcPart = {
                        functionCall: {
                            name: normalizedName,
                            args: safeParseJsonObject(tc.function?.arguments)
                        }
                    };
                    const sig = typeof tc.thoughtSignature === 'string' ? tc.thoughtSignature : (typeof tc.thought_signature === 'string' ? tc.thought_signature : undefined);
                    if (sig)
                        fcPart['thoughtSignature'] = sig;
                    parts.push(fcPart);
                }
                if (parts.length > 0)
                    contents.push({ role, parts });
            }
            else if (msg.role === 'tool') {
                const resolvedName = normalizeToolName(msg.name || (typeof msg.tool_call_id === 'string' ? toolNameById.get(msg.tool_call_id) : '') || 'tool');
                const responsePart = {
                    functionResponse: {
                        name: resolvedName,
                        response: { result: msg.content ?? '' }
                    }
                };
                const lastEntry = contents[contents.length - 1];
                if (lastEntry && lastEntry.role === 'user' && Array.isArray(lastEntry.parts) && lastEntry.parts[0]?.['functionResponse']) {
                    lastEntry.parts.push(responsePart);
                }
                else {
                    contents.push({
                        role: 'user',
                        parts: [responsePart]
                    });
                }
            }
            else {
                if (Array.isArray(msg.content)) {
                    const rawMapped = msg.content.map((part) => {
                        if (!part || typeof part !== 'object')
                            return null;
                        if (part.type === 'text')
                            return { text: typeof part.text === 'string' ? part.text : '' };
                        if (part.type === 'image_url') {
                            const rawUrl = typeof part.image_url?.url === 'string' ? part.image_url.url : '';
                            const marker = rawUrl.indexOf('base64,');
                            if (rawUrl.startsWith('data:') && marker !== -1) {
                                const mime = rawUrl.slice(5, marker).split(';')[0] || 'image/png';
                                const b64 = rawUrl.slice(marker + 7);
                                if (b64)
                                    return { inlineData: { mimeType: mime, data: b64 } };
                            }
                            return { text: '' };
                        }
                        if (part.type === 'image' && part.source?.type === 'base64') {
                            return { inlineData: { mimeType: part.source.media_type, data: part.source.data } };
                        }
                        if (part.type === 'input_audio') {
                            return {
                                inlineData: {
                                    mimeType: mimeTypeForAudioFormat(part.input_audio?.format),
                                    data: part.input_audio?.data
                                }
                            };
                        }
                        if (part.inlineData)
                            return part;
                        return null;
                    }).filter((p) => p !== null);
                    const mappedParts = rawMapped.length > 0 ? rawMapped : [{ text: '' }];
                    contents.push({ role, parts: mappedParts });
                }
                else {
                    const scalar = typeof msg.content === 'string' ? msg.content : (msg.content == null ? '' : JSON.stringify(msg.content));
                    contents.push({ role, parts: [{ text: scalar }] });
                }
            }
        }
        const apiKey = requireApiKey(this.apiKey, 'Gemini');
        const generationConfig = {
            temperature: resolveTemperature(options.temperature, 0.1)
        };
        if (typeof options.maxTokens === 'number' && Number.isFinite(options.maxTokens) && options.maxTokens >= 1) {
            generationConfig['maxOutputTokens'] = Math.floor(options.maxTokens);
        }
        if (options.jsonMode) {
            generationConfig['responseMimeType'] = 'application/json';
        }
        const payload = {
            contents,
            generationConfig
        };
        if (systemParts.length > 0) {
            payload['systemInstruction'] = { parts: systemParts };
        }
        let freeFormPaths = new Map();
        if (options.tools && options.tools.length > 0) {
            const scanReport = scanAndAdaptToolsForProvider(options.tools, 'gemini');
            payload['tools'] = [{
                    functionDeclarations: scanReport.adaptedTools
                }];
            freeFormPaths = scanReport.freeFormPaths;
        }
        const endpoint = this.baseUrl || `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
        const requestOpts = {
            url: endpoint,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey
            },
            signal: options.signal,
            timeoutMs: options.timeoutMs,
            providerLabel: 'Gemini',
            secrets: [apiKey],
            hasApiKey: true,
            allowInsecureHttp: this.allowInsecureHttp
        };
        const data = wantsStreaming(options)
            ? await streamGeminiGenerateContent({
                ...requestOpts,
                payload,
                onChunk: options.onChunk,
                onReasoningChunk: options.onReasoningChunk
            })
            : await safeProviderFetchJson({
                ...requestOpts,
                body: JSON.stringify(payload)
            });
        const firstCandidate = data['candidates']?.[0];
        if (!firstCandidate) {
            const blockReason = data['promptFeedback']?.blockReason;
            const detail = typeof blockReason === 'string' && blockReason ? ` (blockReason: ${blockReason})` : '';
            throw new Error(`No candidate returned from Gemini${detail}`);
        }
        let content = '';
        let reasoningContent = typeof data['reasoningContent'] === 'string' ? data['reasoningContent'] : '';
        const toolCalls = [];
        const candidateParts = Array.isArray(firstCandidate.content?.parts) ? firstCandidate.content.parts : [];
        for (const part of candidateParts) {
            if (!part || typeof part !== 'object')
                continue;
            if (typeof part.text === 'string' && part.text) {
                if (part.thought === true) {
                    reasoningContent += part.text;
                }
                else {
                    content += part.text;
                }
            }
            else if (part.functionCall && typeof part.functionCall === 'object') {
                const callName = normalizeToolName(part.functionCall.name || '');
                if (!callName)
                    continue;
                const serializedArgs = serializeAndDecodeArguments(part.functionCall.args || {}, callName, freeFormPaths);
                const sig = typeof part.thoughtSignature === 'string' ? part.thoughtSignature : (typeof part.thought_signature === 'string' ? part.thought_signature : undefined);
                toolCalls.push({
                    id: sanitizeProviderToolId(part.functionCall.id, 'call_gemini', toolCalls.length),
                    type: 'function',
                    function: {
                        name: callName,
                        arguments: serializedArgs
                    },
                    ...(sig ? { thoughtSignature: sig } : {})
                });
            }
        }
        return {
            content: content.trim(),
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            ...(reasoningContent.trim() ? { reasoningContent: reasoningContent.trim() } : {}),
            usage: this.normalizeUsage(geminiUsageToOpenAIShape(data['usageMetadata']))
        };
    }
}
