import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { LLMProvider } from './base.js';

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
    
    if (options.tools) {
      payload.tools = options.tools.map(tool => ({
        type: 'function',
        function: tool.function ? tool.function : tool
      }));
      payload.tool_choice = "auto";
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
    let content = '';
    let toolCalls = [];

    let reasoningContent = '';

    if (data.choices && data.choices[0] && data.choices[0].message) {
      const message = data.choices[0].message;
      content = message.content || '';
      toolCalls = message.tool_calls || [];
      // DeepSeek and several compatible endpoints return the chain of thought
      // in a sibling field. It was being discarded, so the reasoning the user
      // paid for never reached them.
      reasoningContent = message.reasoning_content || message.reasoning || '';
    }

    return {
      content: content,
      toolCalls: (toolCalls && toolCalls.length > 0) ? toolCalls : undefined,
      reasoningContent: reasoningContent || undefined,
      usage: this.normalizeUsage(data.usage || { prompt_tokens: 0, completion_tokens: 0 })
    };
  }
}
