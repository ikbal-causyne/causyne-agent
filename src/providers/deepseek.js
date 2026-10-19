import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { LLMProvider } from './base.js';

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
    const sanitizedMessages = this.prepareMessages(messages);

    const payload = {
      model: this.model,
      messages: sanitizedMessages,
      temperature: options.temperature || 0.1,
    };

    if (options.jsonMode) {
      payload.response_format = { type: 'json_object' };
    }
    
    let targetUrl = this.baseUrl;
    let headers = {
      'Content-Type': 'application/json'
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    } else {
      throw new Error("API key is required.");
    }

    if (options.tools) {
      payload.tools = options.tools.map(tool => ({
        type: 'function',
        function: tool.function ? tool.function : tool
      }));
      payload.tool_choice = "auto";
    }

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`DeepSeek API Error (${response.status}): ${errorData}`);
    }

    const data = await response.json();
    let content = '';
    let toolCalls = [];
    
    // Support both direct DeepSeek API format and our Cloudflare Proxy format
    if (data.reply !== undefined) {
        // Proxy Format
        content = data.reply || '';
        toolCalls = data.tool_calls || [];
    } else if (data.choices && data.choices[0] && data.choices[0].message) {
        // Direct API Format
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
