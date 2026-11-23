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
import { AcpProvider, isAcpProvider } from './acp.js';
import { PiProvider, isPiProvider } from './pi.js';
import { AntigravityProvider, isAntigravityProvider } from './antigravity.js';
import { OpenRouterProvider } from './openrouter.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
const GROQ_CHAT_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const CEREBRAS_CHAT_ENDPOINT = 'https://api.cerebras.ai/v1/chat/completions';
const MISTRAL_CHAT_ENDPOINT = 'https://api.mistral.ai/v1/chat/completions';
export function createProvider(config) {
    if (!config || typeof config !== 'object') {
        throw new Error('API Key Required. Causyne is a 100% Sovereign BYOK Engine. Please configure your API Provider and Key in Settings.');
    }
    const p = typeof config.provider === 'string' ? config.provider.trim().toLowerCase() : undefined;
    if (p === 'openai')
        return new OpenAIProvider(config);
    if (p === 'anthropic')
        return new AnthropicProvider(config);
    if (p === 'gemini')
        return new GeminiProvider(config);
    if (p === 'gemini-free') {
        return new GeminiProvider({
            ...config,
            apiKey: config.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
            model: config.model || DEFAULT_MODEL_BY_PROVIDER['gemini-free']
        });
    }
    if (p === 'ollama')
        return new OllamaProvider(config);
    if (p === 'deepseek')
        return new DeepSeekProvider(config);
    if (p === 'dashscope-byok' || p === 'dashscope')
        return new DashscopeByokProvider(config);
    if (p === 'qwen')
        return new QwenByokProvider(config);
    if (p === 'groq' || p === 'groq-free') {
        const prov = new OpenAICompatibleProvider({
            ...config,
            apiKey: config.apiKey || process.env.GROQ_API_KEY || '',
            baseUrl: config.baseUrl || GROQ_CHAT_ENDPOINT,
            model: config.model || DEFAULT_MODEL_BY_PROVIDER.groq
        });
        prov.providerLabel = 'Groq';
        return prov;
    }
    if (p === 'cerebras' || p === 'cerebras-free') {
        const prov = new OpenAICompatibleProvider({
            ...config,
            apiKey: config.apiKey || process.env.CEREBRAS_API_KEY || '',
            baseUrl: config.baseUrl || CEREBRAS_CHAT_ENDPOINT,
            model: config.model || DEFAULT_MODEL_BY_PROVIDER.cerebras
        });
        prov.providerLabel = 'Cerebras';
        return prov;
    }
    if (p === 'mistral' || p === 'mistral-free' || p === 'codestral') {
        const prov = new OpenAICompatibleProvider({
            ...config,
            apiKey: config.apiKey || process.env.MISTRAL_API_KEY || '',
            baseUrl: config.baseUrl || MISTRAL_CHAT_ENDPOINT,
            model: config.model || DEFAULT_MODEL_BY_PROVIDER.mistral
        });
        prov.providerLabel = 'Mistral';
        return prov;
    }
    if (p === 'openai-compatible')
        return new OpenAICompatibleProvider(config);
    if (p === 'xai' || p === 'grok')
        return new XAIProvider(config);
    if (p === 'moonshot' || p === 'kimi')
        return new MoonshotProvider(config);
    if (p === 'muse' || p === 'meta')
        return new MuseProvider(config);
    if (p === 'openrouter' || p === 'openrouter-free')
        return new OpenRouterProvider(config);
    if (isAcpProvider(p))
        return new AcpProvider(config);
    if (isPiProvider(p))
        return new PiProvider(config);
    if (isAntigravityProvider(p))
        return new AntigravityProvider(config);
    throw new Error('API Key Required. Causyne is a 100% Sovereign BYOK Engine. Please configure your API Provider and Key in Settings.');
}
