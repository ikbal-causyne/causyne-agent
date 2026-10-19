import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { LLMProvider } from './base.js';

// Direct DashScope API connection for BYOK (unlike dashscope.js which is the proxy for Free Demo)
export class QwenByokProvider extends LLMProvider {
  constructor(config) {
    super(config);
    // Use International/Singapore endpoint by default, allow override via config
    let url = config.baseUrl || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';
    if (url.endsWith('/v1')) url += '/chat/completions';
    else if (url.endsWith('/v1/')) url += 'chat/completions';
    
    this.baseUrl = url;
    this.model = canonicalModelId(config.model || DEFAULT_MODEL_BY_PROVIDER['qwen']);
    this.apiKey = config.apiKey;
    this.visionModels = ['-vl-', '-vl', 'qwen3.6', 'qwen3.7'];
    // Qwen exposes audio on the omni and dedicated audio families only; the
    // -vl- vision models are image-in, text-out and reject an audio block.
    this.audioModels = ['-omni', 'qwen-audio', 'qwen2-audio'];
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
      
      // Enterprise Error Handling: Detect Workspace-bound API Key configuration errors
      if (response.status === 401 && this.apiKey && this.apiKey.startsWith('sk-ws-')) {
        if (!this.baseUrl.includes('ws-')) {
          throw new Error(`\n❌ QWEN WORKSPACE CONFIGURATION ERROR ❌\n\nYou are using a Workspace-bound API Key (starts with sk-ws-), but you haven't configured your Workspace Base URL!\n\nAlibaba requires a specific URL for these keys.\n\n🛠️ HOW TO FIX THIS:\n1. Open your computer terminal.\n2. Run command: causyne-agent config\n3. When asked for 'Custom Base URL', paste your Workspace URL from Alibaba (e.g. https://{Your-Workspace-ID}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions).\n\nAlternatively, use a Standard API Key (starts with sk-) which does not require a custom URL.`);
        }
      }
      
      throw new Error(`Qwen DashScope API Error (${response.status}): ${errorData}`);
    }

    const data = await response.json();
    const content = data.choices[0].message.content;
    const toolCalls = data.choices[0].message.tool_calls;
    
    return {
      content: content || '',
      toolCalls: (toolCalls && toolCalls.length > 0) ? toolCalls : undefined,
      usage: this.normalizeUsage(data.usage)
    };
  }
}
