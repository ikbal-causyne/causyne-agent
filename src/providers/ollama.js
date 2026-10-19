import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { LLMProvider } from './base.js';

export class OllamaProvider extends LLMProvider {
  constructor(config) {
    super(config);
    this.baseUrl = config.baseUrl || 'http://localhost:11434/api/chat';
    this.model = canonicalModelId(config.model || DEFAULT_MODEL_BY_PROVIDER['ollama']);
    // Locally installable vision models. Anything else stays text-only, and a
    // user on an unlisted build can set config.supportsVision explicitly.
    this.visionModels = ['llava', 'vision', 'bakllava', 'moondream', 'minicpm-v', 'gemma3', 'qwen2.5vl', 'qwen3-vl'];
    // No local audio model is common enough to pattern-match honestly, and a
    // wrong guess here fails as an opaque vendor error on the user's own
    // machine. Left empty: config.supportsAudio is the deliberate opt-in,
    // mirroring how supportsVision works for unlisted local builds.
    this.audioModels = [];
  }

  
  normalizeImageBlocks(msg) {
    if (!Array.isArray(msg.content)) return msg;

    const text = [];
    const images = [];

    for (const block of msg.content) {
      if (block.type === 'text') {
        text.push(block.text);
      } else if (block.type === 'image' && block.source?.type === 'base64') {
        images.push(block.source.data);
      } else if (block.type === 'image_url' && typeof block.image_url?.url === 'string') {
        const encoded = block.image_url.url.split('base64,')[1];
        if (encoded) images.push(encoded);
      }
    }

    const normalized = { ...msg, content: text.join('\n') };
    if (images.length > 0) normalized.images = images;
    return normalized;
  }

  async chat(messages, options = {}) {
    const sanitizedMessages = this.prepareMessages(messages);

    const payload = {
      model: this.model,
      messages: sanitizedMessages,
      stream: false,
      options: {
        temperature: options.temperature || 0.1
      }
    };
    
    if (options.tools) {
      payload.tools = options.tools.map(tool => ({
        type: 'function',
        function: tool.function ? tool.function : tool
      }));
    }

    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`Ollama API Error (${response.status}): ${errorData}`);
    }

    const data = await response.json();

    // Ollama returns tool calls with no id. Every stage downstream — the tool
    // result messages, the approval map, and sanitizeSequences, which filters an
    // assistant turn's tool_calls against the ids of the results that follow it —
    // keys on that id. Without one, sanitizeSequences matched nothing and
    // stripped every tool call out of the history on the very next step, so a
    // local model lost all memory of the actions it had just taken.
    const rawToolCalls = data.message?.tool_calls || [];
    const toolCalls = rawToolCalls.map((call, index) => ({
      id: call.id || `call_ollama_${Date.now()}_${index}`,
      type: 'function',
      function: {
        name: call.function?.name,
        // Ollama hands back a parsed object where the OpenAI shape carries a
        // JSON string. Normalise so the whole pipeline sees one contract.
        arguments: typeof call.function?.arguments === 'string'
          ? call.function.arguments
          : JSON.stringify(call.function?.arguments || {})
      }
    }));

    return {
      content: data.message?.content || '',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens: data.prompt_eval_count || 0,
        completionTokens: data.eval_count || 0
      }
    };
  }
}
