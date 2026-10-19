// Provider construction, in one place.
//


// ("can the selected model hear?"), and a second copy would drift the moment a


import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import { OllamaProvider } from './ollama.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { DeepSeekProvider } from './deepseek.js';
import { QwenByokProvider } from './qwen-byok.js';
import { DashscopeByokProvider } from './dashscope-byok.js';
import { XAIProvider } from './xai.js';
import { MoonshotProvider } from './moonshot.js';
import { MuseProvider } from './muse.js';

export function createProvider(config) {
  const p = config.provider?.toLowerCase();
  if (p === 'openai') return new OpenAIProvider(config);
  if (p === 'anthropic') return new AnthropicProvider(config);
  if (p === 'gemini') return new GeminiProvider(config);
  if (p === 'ollama') return new OllamaProvider(config);
  if (p === 'deepseek') return new DeepSeekProvider(config);
  if (p === 'dashscope-byok' || p === 'dashscope') return new DashscopeByokProvider(config);
  if (p === 'qwen') return new QwenByokProvider(config);
  if (p === 'openai-compatible') return new OpenAICompatibleProvider(config);
  if (p === 'xai' || p === 'grok') return new XAIProvider(config);
  if (p === 'moonshot' || p === 'kimi') return new MoonshotProvider(config);
  // Meta Model API. 'meta' and 'muse' both reach it: the vendor is Meta, the
  // model family is Muse, and users say either.
  if (p === 'muse' || p === 'meta') return new MuseProvider(config);

  throw new Error("API Key Required. Causyne is a 100% Sovereign BYOK Engine. Please configure your API Provider and Key in Settings.");
}
