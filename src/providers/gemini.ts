import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { LLMProvider, mimeTypeForAudioFormat, type ChatOptions, type ChatResponse, type ChatResponseToolCall, type ProviderConfig } from './base.js';
import {
  scanAndAdaptToolsForProvider,
  adaptSchemaForGemini,
  isEmptyObjectSchema,
  normalizeToolName
} from '../tools/toolScanner.js';
import {
  safeParseJsonObject,
  sanitizeProviderToolId,
  serializeAndDecodeArguments
} from './wireNormalizer.js';
import {
  requireApiKey,
  resolveTemperature,
  safeProviderFetchJson
} from './byokHttp.js';
import { streamGeminiGenerateContent, wantsStreaming } from './byokStream.js';

export { adaptSchemaForGemini, isEmptyObjectSchema };

export function geminiUsageToOpenAIShape(usageMetadata: Record<string, any> | null | undefined): {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details: { cached_tokens: number };
} {
  const prompt = usageMetadata?.['promptTokenCount'] || 0;
  const candidates = usageMetadata?.['candidatesTokenCount'] || 0;
  const thoughts = usageMetadata?.['thoughtsTokenCount'] || 0;
  const total = usageMetadata?.['totalTokenCount'] || 0;

  const completion = total > prompt ? total - prompt : candidates + thoughts;

  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    prompt_tokens_details: { cached_tokens: usageMetadata?.['cachedContentTokenCount'] || 0 }
  };
}

export class GeminiProvider extends LLMProvider {
  constructor(config: ProviderConfig = {}) {
    super(config);
    this.model = String(canonicalModelId(config.model || DEFAULT_MODEL_BY_PROVIDER['gemini']) || '');
    this.baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
    this.visionModels = ['gemini-'];
    this.imagePayloadFormat = 'gemini';
    this.audioModels = ['gemini-'];
    this.audioPayloadFormat = 'gemini';
  }

  override async chat(messages: any[], options: ChatOptions = {}): Promise<ChatResponse> {
    messages = this.prepareMessages(messages);
    const systemParts: Array<{ text: string }> = [];
    const contents: Array<{ role: string; parts: Array<Record<string, any>> }> = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        const text = typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content);
        if (text) systemParts.push({ text });
        continue;
      }

      const role = msg.role === 'assistant' ? 'model' : 'user';

      if (msg.tool_calls) {
        const parts: Array<Record<string, any>> = [];
        if (msg.content) parts.push({ text: String(msg.content) });
        for (const tc of msg.tool_calls) {
          parts.push({
            functionCall: {
              name: normalizeToolName(tc.function?.name || ''),
              args: safeParseJsonObject(tc.function?.arguments)
            }
          });
        }
        contents.push({ role, parts });
      } else if (msg.role === 'tool') {
        const responsePart = {
          functionResponse: {
            name: normalizeToolName(msg.name || ''),
            response: { result: msg.content ?? '' }
          }
        };
        const lastEntry = contents[contents.length - 1];
        if (lastEntry && lastEntry.role === 'user' && Array.isArray(lastEntry.parts) && lastEntry.parts[0]?.['functionResponse']) {
          lastEntry.parts.push(responsePart);
        } else {
          contents.push({
            role: 'user',
            parts: [responsePart]
          });
        }
      } else {
        if (Array.isArray(msg.content)) {
          const mappedParts = msg.content.map((part: any) => {
            if (part.type === 'text') return { text: part.text };
            if (part.type === 'image_url') {
              const b64 = part.image_url.url.split('base64,')[1];
              const mime = part.image_url.url.split(';')[0].replace('data:', '');
              return { inlineData: { mimeType: mime, data: b64 } };
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
            if (part.inlineData) return part;
            return { text: '' };
          });
          contents.push({ role, parts: mappedParts });
        } else {
          contents.push({ role, parts: [{ text: msg.content ?? '' }] });
        }
      }
    }

    const apiKey = requireApiKey(this.apiKey, 'Gemini');
    const payload: Record<string, any> = {
      contents,
      generationConfig: {
        temperature: resolveTemperature(options.temperature, 0.1)
      }
    };

    if (systemParts.length > 0) {
      payload['systemInstruction'] = { parts: systemParts };
    }

    let freeFormPaths = new Map<string, string[][]>();
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
      hasApiKey: true
    };

    const data: Record<string, any> = wantsStreaming(options)
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
      throw new Error('No candidate returned from Gemini');
    }

    let content = '';
    let reasoningContent = typeof data['reasoningContent'] === 'string' ? data['reasoningContent'] : '';
    const toolCalls: ChatResponseToolCall[] = [];
    const candidateParts = Array.isArray(firstCandidate.content?.parts) ? firstCandidate.content.parts : [];

    for (const part of candidateParts) {
      if (part.text) {
        if (part.thought === true) {
          reasoningContent += part.text;
        } else {
          content += part.text;
        }
      } else if (part.functionCall) {
        const callName = normalizeToolName(part.functionCall.name || '');
        const serializedArgs = serializeAndDecodeArguments(part.functionCall.args || {}, callName, freeFormPaths);
        toolCalls.push({
          id: sanitizeProviderToolId(part.functionCall.id, 'call_gemini', toolCalls.length),
          type: 'function',
          function: {
            name: callName,
            arguments: serializedArgs
          }
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
