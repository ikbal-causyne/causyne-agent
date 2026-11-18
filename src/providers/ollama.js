import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { LLMProvider } from './base.js';
import { scanAndAdaptToolsForProvider } from '../tools/toolScanner.js';
import {
  normalizeMessagesForOllama,
  normalizeOpenAIToolCalls,
  extractTextToolCalls
} from './wireNormalizer.js';
import { stripToolCallMarkup } from '../implementationPlan.js';

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
    const sanitizedMessages = normalizeMessagesForOllama(this.prepareMessages(messages));

    const payload = {
      model: this.model,
      messages: sanitizedMessages,
      stream: false,
      options: {
        temperature: options.temperature || 0.1
      }
    };
    
    let freeFormPaths = new Map();
    if (options.tools && options.tools.length > 0) {
      const scanReport = scanAndAdaptToolsForProvider(options.tools, 'ollama');
      payload.tools = scanReport.adaptedTools;
      freeFormPaths = scanReport.freeFormPaths;
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

    // Ollama returns tool calls with no id and object arguments instead of JSON strings.
    // Normalize through wireNormalizer so sanitizeSequences and toolSelfRepair see one contract.
    let content = typeof data.message?.content === 'string' ? data.message.content : '';
    let toolCalls = normalizeOpenAIToolCalls(data.message?.tool_calls, freeFormPaths, 'call_ollama');
    if (toolCalls.length === 0 && content) {
      const extracted = extractTextToolCalls(content, 'call_ollama_text', freeFormPaths);
      if (extracted.length > 0) {
        toolCalls = extracted;
        content = stripToolCallMarkup(content).trim();
      }
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens: data.prompt_eval_count || 0,
        completionTokens: data.eval_count || 0
      }
    };
  }
}
