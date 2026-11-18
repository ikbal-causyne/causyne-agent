import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { LLMProvider } from './base.js';
import { scanAndAdaptToolsForProvider } from '../tools/toolScanner.js';
import { normalizeOpenAIChatChoiceResponse } from './wireNormalizer.js';

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
    const sanitizedMessages = this.prepareMessages(messages);

    const payload = {
      model: this.model,
      messages: sanitizedMessages,
      temperature: options.temperature || 0.1,
    };

    if (options.jsonMode) {
      payload.response_format = { type: 'json_object' };
    }
    
    let headers = {
      'Content-Type': 'application/json'
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    } else {
      // EXPLICIT BYOK CONSTRAINT
      throw new Error(`xAI (Grok) API requires a valid API key (BYOK mode). Please set it in your configuration.`);
    }

    let freeFormPaths = new Map();
    if (options.tools && options.tools.length > 0) {
      const scanReport = scanAndAdaptToolsForProvider(options.tools, 'xai');
      payload.tools = scanReport.adaptedTools;
      payload.tool_choice = "auto";
      freeFormPaths = scanReport.freeFormPaths;
    }

    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`xAI API Error (${response.status}): ${errorData}`);
    }

    const data = await response.json();
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
