import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { LLMProvider } from './base.js';
import { scanAndAdaptToolsForProvider } from '../tools/toolScanner.js';
import { normalizeOpenAIChatChoiceResponse } from './wireNormalizer.js';
import {
  requireApiKey,
  resolveTemperature,
  safeProviderFetchJson
} from './byokHttp.js';
import { streamOpenAICompatibleChat, wantsStreaming } from './byokStream.js';

export class XAIProvider extends LLMProvider {
  constructor(config) {
    super(config);
    this.baseUrl = 'https://api.x.ai/v1/chat/completions';
    this.model = canonicalModelId(config.model || DEFAULT_MODEL_BY_PROVIDER['xai']);
    this.visionModels = ['grok-4', 'vision'];
    // Grok has no audio input block on the chat completions API.
    this.audioModels = [];
  }

  async chat(messages, options = {}) {
    const apiKey = requireApiKey(this.apiKey, 'xAI (Grok)');
    const sanitizedMessages = this.prepareMessages(messages);

    const payload = {
      model: this.model,
      messages: sanitizedMessages,
      temperature: resolveTemperature(options.temperature, 0.1),
    };

    if (options.jsonMode) {
      payload.response_format = { type: 'json_object' };
    }

    let freeFormPaths = new Map();
    if (options.tools && options.tools.length > 0) {
      const scanReport = scanAndAdaptToolsForProvider(options.tools, 'xai');
      payload.tools = scanReport.adaptedTools;
      payload.tool_choice = "auto";
      freeFormPaths = scanReport.freeFormPaths;
    }

    const requestOpts = {
      url: this.baseUrl,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      providerLabel: 'xAI',
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
      prefix: 'call_xai',
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
