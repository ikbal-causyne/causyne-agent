import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { LLMProvider } from './base.js';
import { scanAndAdaptToolsForProvider } from '../tools/toolScanner.js';
import { normalizeOpenAIChatChoiceResponse } from './wireNormalizer.js';

export class OpenAICompatibleProvider extends LLMProvider {
  constructor(config) {
    super(config);

    // A custom endpoint can serve anything, so guessing from the model id would
    // be wrong as often as right. config.supportsAudio is the deliberate opt-in,
    // exactly as config.supportsVision already is for images.
    this.audioModels = [];
    // 'low' | 'medium' | 'high' | 'off'. Unset means: do not send the parameter.
    this.reasoningEffort = config.reasoningEffort || null;
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1/chat/completions';
    this.model = canonicalModelId(config.model || DEFAULT_MODEL_BY_PROVIDER['openai']);
  }

  async chat(messages, options = {}) {
    const preparedMessages = this.prepareMessages(messages);
    const payload = {
      model: this.model,
      messages: preparedMessages,
      temperature: options.temperature || 0.1,
    };

    // Reasoning models take an effort dial. Sending it to a model that does not
    // support it is rejected, so it only goes out when the user configured it —
    // a custom OpenAI-compatible endpoint may serve anything, and this provider
    // cannot know the model list in advance.
    if (this.reasoningEffort && this.reasoningEffort !== 'off') {
      payload.reasoning_effort = this.reasoningEffort;
    }

    if (options.jsonMode) {
      payload.response_format = { type: 'json_object' };
    }
    
    let freeFormPaths = new Map();
    if (options.tools && options.tools.length > 0) {
      const scanReport = scanAndAdaptToolsForProvider(options.tools, 'openai');
      payload.tools = scanReport.adaptedTools;
      payload.tool_choice = "auto";
      freeFormPaths = scanReport.freeFormPaths;
    }

    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`OpenAI-Compatible API Error (${response.status}): ${errorData}`);
    }

    const data = await response.json();
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
