import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { LLMProvider, type ChatOptions, type ChatResponse, type ProviderConfig } from './base.js';
import { scanAndAdaptToolsForProvider } from '../tools/toolScanner.js';
import {
  normalizeMessagesForOllama,
  normalizeOpenAIToolCalls,
  extractTextToolCalls
} from './wireNormalizer.js';
import { stripToolCallMarkup } from '../implementationPlan.js';
import { resolveTemperature, safeProviderFetchJson } from './byokHttp.js';
import { streamOllamaChat, wantsStreaming } from './byokStream.js';

export class OllamaProvider extends LLMProvider {
  allowInsecureHttp: boolean;

  constructor(config: ProviderConfig = {}) {
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
      } catch {
        resolvedUrl = rawUrl;
      }
    }
    this.baseUrl = resolvedUrl;
    this.allowInsecureHttp = config.allowInsecureHttp === true;
    this.model = String(canonicalModelId(config.model || DEFAULT_MODEL_BY_PROVIDER['ollama']) || '');
    this.visionModels = ['llava', 'vision', 'bakllava', 'moondream', 'minicpm-v', 'gemma3', 'qwen2.5vl', 'qwen3-vl'];
    this.audioModels = [];
  }

  override normalizeImageBlocks(msg: any): any {
    if (!Array.isArray(msg.content)) return msg;

    const text: string[] = [];
    const images: string[] = [];

    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        text.push(block.text);
      } else if (block.type === 'image' && block.source?.type === 'base64') {
        images.push(block.source.data);
      } else if (block.type === 'image_url' && typeof block.image_url?.url === 'string') {
        const encoded = block.image_url.url.split('base64,')[1];
        if (encoded) images.push(encoded);
      }
    }

    const normalized: Record<string, any> = { ...msg, content: text.join('\n') };
    if (images.length > 0) normalized['images'] = images;
    return normalized;
  }

  override async chat(messages: any[], options: ChatOptions = {}): Promise<ChatResponse> {
    const sanitizedMessages = normalizeMessagesForOllama(this.prepareMessages(messages));

    const ollamaOptions: Record<string, any> = {
      temperature: resolveTemperature(options.temperature, 0.1)
    };
    if (typeof options.maxTokens === 'number' && Number.isFinite(options.maxTokens) && options.maxTokens >= 1) {
      ollamaOptions['num_predict'] = Math.floor(options.maxTokens);
    }
    const payload: Record<string, any> = {
      model: this.model,
      messages: sanitizedMessages,
      stream: false,
      options: ollamaOptions,
      ...(options.jsonMode ? { format: 'json' } : {})
    };

    let freeFormPaths = new Map<string, string[][]>();
    if (options.tools && options.tools.length > 0) {
      const scanReport = scanAndAdaptToolsForProvider(options.tools, 'ollama');
      payload['tools'] = scanReport.adaptedTools;
      freeFormPaths = scanReport.freeFormPaths;
    }

    const endpoint = this.baseUrl || 'http://localhost:11434/api/chat';
    const trimmedKey = typeof this.apiKey === 'string' ? this.apiKey.trim() : '';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (trimmedKey) headers['Authorization'] = `Bearer ${trimmedKey}`;
    const requestOpts = {
      url: endpoint,
      method: 'POST',
      headers,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      providerLabel: 'Ollama',
      secrets: trimmedKey ? [trimmedKey] : [],
      hasApiKey: Boolean(trimmedKey),
      allowInsecureHttp: this.allowInsecureHttp
    };

    const data: Record<string, any> = wantsStreaming(options)
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
        promptTokens: typeof data['prompt_eval_count'] === 'number' && Number.isFinite(data['prompt_eval_count']) && data['prompt_eval_count'] > 0 ? data['prompt_eval_count'] : 0,
        completionTokens: typeof data['eval_count'] === 'number' && Number.isFinite(data['eval_count']) && data['eval_count'] > 0 ? data['eval_count'] : 0
      }
    };
  }
}
