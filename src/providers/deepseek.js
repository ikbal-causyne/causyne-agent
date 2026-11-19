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

export class DeepSeekProvider extends LLMProvider {
  constructor(config) {
    super(config);
    this.baseUrl = 'https://api.deepseek.com/v1/chat/completions';
    this.model = canonicalModelId(config.model || DEFAULT_MODEL_BY_PROVIDER['deepseek']);
    // The deepseek-chat line is text-only; only the VL builds accept images.
    this.visionModels = ['-vl'];
    // DeepSeek exposes no audio input endpoint.
    this.audioModels = [];
  }

  async chat(messages, options = {}) {
    const apiKey = requireApiKey(this.apiKey, 'DeepSeek');
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
      const scanReport = scanAndAdaptToolsForProvider(options.tools, 'deepseek');
      payload.tools = scanReport.adaptedTools;
      payload.tool_choice = "auto";
      freeFormPaths = scanReport.freeFormPaths;
    }

    const data = await safeProviderFetchJson({
      url: this.baseUrl,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload),
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      providerLabel: 'DeepSeek',
      secrets: [apiKey],
      hasApiKey: true
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
