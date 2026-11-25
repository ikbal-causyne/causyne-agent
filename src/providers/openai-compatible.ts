import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { LLMProvider, type ChatOptions, type ChatResponse, type ProviderConfig } from './base.js';
import { scanAndAdaptToolsForProvider } from '../tools/toolScanner.js';
import {
  normalizeMessagesForMistral,
  normalizeOpenAIChatChoiceResponse,
  toMistralToolCallId
} from './wireNormalizer.js';
import {
  isLoopbackHost,
  ProviderHttpError,
  requireApiKey,
  resolveTemperature,
  safeProviderFetchJson
} from './byokHttp.js';
import { streamOpenAICompatibleChat, wantsStreaming } from './byokStream.js';

export function isMistralEndpoint(endpoint: string, providerLabel = ''): boolean {
  if (providerLabel.trim().toLowerCase() === 'mistral') return true;
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return host === 'api.mistral.ai' || host.endsWith('.mistral.ai');
  } catch {
    return false;
  }
}

export class OpenAICompatibleProvider extends LLMProvider {
  reasoningEffort: string | null;
  allowInsecureHttp: boolean;
  providerLabel: string;

  constructor(config: ProviderConfig = {}) {
    super(config);
    this.audioModels = [];
    const rawEffort = typeof config.reasoningEffort === 'string' ? config.reasoningEffort.trim().toLowerCase() : '';
    this.reasoningEffort = rawEffort || null;
    const rawUrl = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : '';
    let resolvedUrl = rawUrl || 'https://api.openai.com/v1/chat/completions';
    if (rawUrl) {
      try {
        const parsed = new URL(rawUrl);
        if (parsed.pathname === '' || parsed.pathname === '/' || parsed.pathname === '/v1' || parsed.pathname === '/v1/') {
          parsed.pathname = '/v1/chat/completions';
          resolvedUrl = parsed.toString();
        }
      } catch {
        resolvedUrl = rawUrl;
      }
    }
    this.baseUrl = resolvedUrl;
    this.allowInsecureHttp = config.allowInsecureHttp === true;
    this.providerLabel = 'OpenAI-Compatible';
    this.model = String(canonicalModelId(config.model || DEFAULT_MODEL_BY_PROVIDER['openai']) || '');
  }

  rejectsSamplingParameters(): boolean {
    return false;
  }

  usesMaxCompletionTokens(): boolean {
    return false;
  }

  supportsPromptCacheKey(): boolean {
    return false;
  }

  supportsReasoningEffort(): boolean {
    const endpoint = this.baseUrl || 'https://api.openai.com/v1/chat/completions';
    if (isMistralEndpoint(endpoint, this.providerLabel)) return false;
    const lowered = (this.model || '').trim().toLowerCase();
    if (!lowered) return false;
    if (/^(?:o[134]|gpt-[56])(?:$|[-.])/.test(lowered) && !lowered.includes('-chat')) return true;
    return lowered.includes('gpt-oss')
      || lowered.includes('qwen3')
      || lowered.includes('qwen-3')
      || lowered.includes('qwq')
      || lowered.includes('deepseek-r1')
      || lowered.includes('reasoning');
  }

  override async chat(messages: any[], options: ChatOptions = {}): Promise<ChatResponse> {
    const opts = options && typeof options === 'object' ? options : {};
    const endpoint = this.baseUrl || 'https://api.openai.com/v1/chat/completions';
    const isMistral = isMistralEndpoint(endpoint, this.providerLabel);
    const preparedBase = this.prepareMessages(messages);
    const preparedMessages = isMistral ? normalizeMessagesForMistral(preparedBase) : preparedBase;
    const payload: Record<string, any> = {
      model: this.model,
      messages: preparedMessages
    };
    if (!this.rejectsSamplingParameters()) {
      payload['temperature'] = resolveTemperature(opts.temperature, 0.1);
    }

    if (this.reasoningEffort && this.reasoningEffort !== 'off' && this.supportsReasoningEffort()) {
      payload['reasoning_effort'] = this.reasoningEffort;
    }

    if (typeof opts.maxTokens === 'number' && Number.isFinite(opts.maxTokens) && opts.maxTokens >= 1) {
      const tokenLimit = Math.floor(opts.maxTokens);
      if (this.usesMaxCompletionTokens()) {
        payload['max_completion_tokens'] = tokenLimit;
      } else {
        payload['max_tokens'] = tokenLimit;
      }
    }

    if (opts.jsonMode) {
      payload['response_format'] = { type: 'json_object' };
    }

    if (this.supportsPromptCacheKey() && typeof opts.cacheKey === 'string') {
      const safeKey = opts.cacheKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      if (safeKey) {
        payload['prompt_cache_key'] = safeKey;
      }
    }

    let freeFormPaths = new Map<string, string[][]>();
    if (Array.isArray(opts.tools) && opts.tools.length > 0) {
      const scanReport = scanAndAdaptToolsForProvider(opts.tools, 'openai');
      payload['tools'] = scanReport.adaptedTools;
      payload['tool_choice'] = 'auto';
      freeFormPaths = scanReport.freeFormPaths;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    const trimmedKey = typeof this.apiKey === 'string' ? this.apiKey.trim() : '';
    let isLocalEndpoint = false;
    try {
      isLocalEndpoint = isLoopbackHost(new URL(endpoint).hostname);
    } catch {
      isLocalEndpoint = false;
    }
    if (trimmedKey) {
      headers['Authorization'] = `Bearer ${trimmedKey}`;
    } else if (!isLocalEndpoint) {
      requireApiKey(this.apiKey, this.providerLabel);
    }

    const requestOpts = {
      url: endpoint,
      method: 'POST',
      headers,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      providerLabel: this.providerLabel,
      secrets: trimmedKey ? [trimmedKey] : [],
      hasApiKey: Boolean(trimmedKey),
      allowInsecureHttp: this.allowInsecureHttp
    };

    const runRequest = async (reqPayload: Record<string, any>) => (
      wantsStreaming(opts)
        ? await streamOpenAICompatibleChat({
            ...requestOpts,
            payload: reqPayload,
            onChunk: opts.onChunk,
            onReasoningChunk: opts.onReasoningChunk
          })
        : await safeProviderFetchJson({
            ...requestOpts,
            body: JSON.stringify(reqPayload)
          })
    );

    let data: Record<string, any>;
    try {
      data = await runRequest(payload);
    } catch (err: unknown) {
      const rejectedReasoningEffort = 'reasoning_effort' in payload
        && err instanceof ProviderHttpError
        && err.status === 400
        && /(?:reasoning_effort|unrecognized|unknown field|extra inputs|not permitted|unsupported parameter)/i.test(err.message);
      if (!rejectedReasoningEffort) throw err;
      const fallbackPayload = { ...payload };
      delete fallbackPayload['reasoning_effort'];
      data = await runRequest(fallbackPayload);
    }
    const normalized = normalizeOpenAIChatChoiceResponse(data, {
      prefix: 'call_oai',
      freeFormPaths
    });
    const finalToolCalls = isMistral && Array.isArray(normalized.toolCalls)
      ? normalized.toolCalls.map((tc, idx) => ({ ...tc, id: toMistralToolCallId(tc.id, idx) }))
      : normalized.toolCalls;

    return {
      content: normalized.content,
      toolCalls: finalToolCalls,
      reasoningContent: normalized.reasoningContent,
      usage: this.normalizeUsage(normalized.rawUsage)
    };
  }
}
