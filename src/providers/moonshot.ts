import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { LLMProvider, type ChatOptions, type ChatResponse, type ProviderConfig } from './base.js';
import { scanAndAdaptToolsForProvider } from '../tools/toolScanner.js';
import { normalizeOpenAIChatChoiceResponse } from './wireNormalizer.js';
import {
  requireApiKey,
  resolveTemperature,
  safeProviderFetchJson
} from './byokHttp.js';
import { streamOpenAICompatibleChat, wantsStreaming } from './byokStream.js';

export class MoonshotProvider extends LLMProvider {
  allowInsecureHttp: boolean;

  constructor(config: ProviderConfig = {}) {
    super(config);
    const customUrl = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : '';
    this.baseUrl = customUrl || 'https://api.moonshot.ai/v1/chat/completions';
    this.allowInsecureHttp = config.allowInsecureHttp === true;
    this.model = String(canonicalModelId(config.model || DEFAULT_MODEL_BY_PROVIDER['moonshot']) || '');
    this.visionModels = ['kimi-k3', 'kimi-k2.5', 'vision'];
    this.audioModels = [];
  }

  override async chat(messages: any[], options: ChatOptions = {}): Promise<ChatResponse> {
    const apiKey = requireApiKey(this.apiKey, 'Moonshot AI (Kimi)');
    const sanitizedMessages = this.prepareMessages(messages);

    const isThinkingModel = (this.model || '').trim().toLowerCase().includes('-thinking');
    const payload: Record<string, any> = {
      model: this.model,
      messages: sanitizedMessages
    };
    if (!isThinkingModel) {
      payload['temperature'] = resolveTemperature(options.temperature, 0.1);
    }
    if (typeof options.maxTokens === 'number' && Number.isFinite(options.maxTokens) && options.maxTokens >= 1) {
      payload['max_tokens'] = Math.floor(options.maxTokens);
    }

    if (options.jsonMode) {
      payload['response_format'] = { type: 'json_object' };
    }

    let freeFormPaths = new Map<string, string[][]>();
    if (options.tools && options.tools.length > 0) {
      const scanReport = scanAndAdaptToolsForProvider(options.tools, 'moonshot');
      payload['tools'] = scanReport.adaptedTools;
      payload['tool_choice'] = 'auto';
      freeFormPaths = scanReport.freeFormPaths;
    }

    const endpoint = this.baseUrl || 'https://api.moonshot.ai/v1/chat/completions';
    const requestOpts = {
      url: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      providerLabel: 'Moonshot AI',
      secrets: [apiKey],
      hasApiKey: true,
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
      prefix: 'call_moonshot',
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
