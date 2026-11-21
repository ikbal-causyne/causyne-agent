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

export class DeepSeekProvider extends LLMProvider {
  constructor(config: ProviderConfig = {}) {
    super(config);
    this.baseUrl = 'https://api.deepseek.com/v1/chat/completions';
    this.model = String(canonicalModelId(config.model || DEFAULT_MODEL_BY_PROVIDER['deepseek']) || '');
    this.visionModels = ['-vl'];
    this.audioModels = [];
    this.preserveReasoningContent = this.isReasonerModel();
  }

  isReasonerModel(): boolean {
    const lowered = (this.model || '').trim().toLowerCase();
    return lowered.includes('reasoner') || lowered.startsWith('deepseek-r1');
  }

  override async chat(messages: any[], options: ChatOptions = {}): Promise<ChatResponse> {
    const apiKey = requireApiKey(this.apiKey, 'DeepSeek');
    this.preserveReasoningContent = this.isReasonerModel();
    const sanitizedMessages = this.prepareMessages(messages);

    const payload: Record<string, any> = {
      model: this.model,
      messages: sanitizedMessages
    };
    if (!this.isReasonerModel()) {
      payload['temperature'] = resolveTemperature(options.temperature, 0.1);
    }

    if (options.jsonMode) {
      payload['response_format'] = { type: 'json_object' };
    }

    let freeFormPaths = new Map<string, string[][]>();
    if (options.tools && options.tools.length > 0) {
      const scanReport = scanAndAdaptToolsForProvider(options.tools, 'deepseek');
      payload['tools'] = scanReport.adaptedTools;
      payload['tool_choice'] = 'auto';
      freeFormPaths = scanReport.freeFormPaths;
    }

    const endpoint = this.baseUrl || 'https://api.deepseek.com/v1/chat/completions';
    const requestOpts = {
      url: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      providerLabel: 'DeepSeek',
      secrets: [apiKey],
      hasApiKey: true
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
      prefix: 'call_deepseek',
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
