import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { LLMProvider, type ChatOptions, type ChatResponse, type ProviderConfig } from './base.js';
import { scanAndAdaptToolsForProvider } from '../tools/toolScanner.js';
import { normalizeOpenAIChatChoiceResponse } from './wireNormalizer.js';
import {
  isLoopbackHost,
  requireApiKey,
  resolveTemperature,
  safeProviderFetchJson
} from './byokHttp.js';
import { streamOpenAICompatibleChat, wantsStreaming } from './byokStream.js';

export class OpenAICompatibleProvider extends LLMProvider {
  reasoningEffort: string | null;
  allowInsecureHttp: boolean;
  providerLabel: string;

  constructor(config: ProviderConfig = {}) {
    super(config);
    this.audioModels = [];
    this.reasoningEffort = config.reasoningEffort || null;
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1/chat/completions';
    this.allowInsecureHttp = config.allowInsecureHttp === true;
    this.providerLabel = 'OpenAI-Compatible';
    this.model = String(canonicalModelId(config.model || DEFAULT_MODEL_BY_PROVIDER['openai']) || '');
  }

  override async chat(messages: any[], options: ChatOptions = {}): Promise<ChatResponse> {
    const preparedMessages = this.prepareMessages(messages);
    const payload: Record<string, any> = {
      model: this.model,
      messages: preparedMessages,
      temperature: resolveTemperature(options.temperature, 0.1)
    };

    if (this.reasoningEffort && this.reasoningEffort !== 'off') {
      payload['reasoning_effort'] = this.reasoningEffort;
    }

    if (options.jsonMode) {
      payload['response_format'] = { type: 'json_object' };
    }

    let freeFormPaths = new Map<string, string[][]>();
    if (options.tools && options.tools.length > 0) {
      const scanReport = scanAndAdaptToolsForProvider(options.tools, 'openai');
      payload['tools'] = scanReport.adaptedTools;
      payload['tool_choice'] = 'auto';
      freeFormPaths = scanReport.freeFormPaths;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    const trimmedKey = typeof this.apiKey === 'string' ? this.apiKey.trim() : '';
    const endpoint = this.baseUrl || 'https://api.openai.com/v1/chat/completions';
    let isLocalEndpoint = false;
    try {
      isLocalEndpoint = isLoopbackHost(new URL(endpoint).hostname);
    } catch {
      isLocalEndpoint = false;
    }
    if (trimmedKey) {
      headers['Authorization'] = `Bearer ${trimmedKey}`;
    } else if (!isLocalEndpoint) {
      requireApiKey(this.apiKey, this.providerLabel);
    }

    const requestOpts = {
      url: endpoint,
      method: 'POST',
      headers,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      providerLabel: this.providerLabel,
      secrets: trimmedKey ? [trimmedKey] : [],
      hasApiKey: Boolean(trimmedKey),
      allowInsecureHttp: this.allowInsecureHttp
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
      prefix: 'call_oai',
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
