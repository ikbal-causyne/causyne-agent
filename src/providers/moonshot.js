import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { LLMProvider } from './base.js';

export class MoonshotProvider extends LLMProvider {
  constructor(config) {
    super(config);
    this.baseUrl = 'https://api.moonshot.ai/v1/chat/completions';
    this.model = canonicalModelId(config.model || DEFAULT_MODEL_BY_PROVIDER['moonshot']);
    this.visionModels = ['kimi-k3', 'kimi-k2.5', 'vision'];
    // Kimi exposes no audio input on the chat completions API.
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
      throw new Error(`Moonshot AI (Kimi) API requires a valid API key (BYOK mode). Please set it in your configuration.`);
    }

    if (options.tools) {
      payload.tools = options.tools.map(tool => ({
        type: 'function',
        function: tool.function ? tool.function : tool
      }));
      payload.tool_choice = "auto";
    }

    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`Moonshot AI API Error (${response.status}): ${errorData}`);
    }

    const data = await response.json();
    let content = '';
    let toolCalls = [];
    
    if (data.choices && data.choices[0] && data.choices[0].message) {
        content = data.choices[0].message.content || '';
        toolCalls = data.choices[0].message.tool_calls || [];
    }
    
    return {
      content: content,
      toolCalls: (toolCalls && toolCalls.length > 0) ? toolCalls : undefined,
      usage: this.normalizeUsage(data.usage || { prompt_tokens: 0, completion_tokens: 0 })
    };
  }
}
