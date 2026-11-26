import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { LLMProvider, type ChatOptions, type ChatResponse, type ProviderConfig } from './base.js';
import { scanAndAdaptToolsForProvider } from '../tools/toolScanner.js';
import { normalizeOpenAIChatChoiceResponse } from './wireNormalizer.js';
import {
  requireApiKey,
  resolveTemperature,
  safeProviderFetchJson
} from './byokHttp.js';
import { streamOpenAICompatibleChat, wantsStreaming } from './byokStream.js';

export class MoonshotProvider extends LLMProvider {
  allowInsecureHttp: boolean;
  reasoningEffort: string | null;

  constructor(config: ProviderConfig = {}) {
    super(config);
    const customUrl = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : '';
    this.baseUrl = customUrl || 'https://api.moonshot.ai/v1/chat/completions';
    this.allowInsecureHttp = config.allowInsecureHttp === true;
    const rawEffort = typeof config.reasoningEffort === 'string' ? config.reasoningEffort.trim().toLowerCase() : '';
    this.reasoningEffort = rawEffort || null;
    this.model = String(canonicalModelId(config.model || DEFAULT_MODEL_BY_PROVIDER['moonshot']) || '');
    this.visionModels = ['k3', 'kimi-k3', 'kimi-k2.5', 'vision'];
    this.audioModels = [];
    this.preserveReasoningContent = true;
  }

  override async chat(messages: any[], options: ChatOptions = {}): Promise<ChatResponse> {
    const apiKey = requireApiKey(this.apiKey, 'Moonshot AI (Kimi)');
    const sanitizedMessages = this.prepareMessages(messages);

    const loweredModel = (this.model || '').trim().toLowerCase();
    const isThinkingModel = loweredModel.includes('-thinking') || loweredModel.startsWith('k3.1-pro');
    const payload: Record<string, any> = {
      model: this.model,
      messages: sanitizedMessages
    };
    if (!isThinkingModel) {
      payload['temperature'] = resolveTemperature(options.temperature, 0.1);
    }
    if (this.reasoningEffort && (isThinkingModel || loweredModel.startsWith('kimi-k2.5') || loweredModel.startsWith('kimi-k2.7') || loweredModel.startsWith('k3'))) {
      if (this.reasoningEffort === 'off' || this.reasoningEffort === 'none') {
        payload['thinking'] = { type: 'disabled' };
      } else {
        payload['thinking'] = { type: 'enabled' };
        if (['low', 'medium', 'high'].includes(this.reasoningEffort)) {
          payload['reasoning_effort'] = this.reasoningEffort;
        }
      }
    }
    if (typeof options.maxTokens === 'number' && Number.isFinite(options.maxTokens) && options.maxTokens >= 1) {
      payload['max_tokens'] = Math.floor(options.maxTokens);
    }

    if (options.jsonMode) {
      payload['response_format'] = { type: 'json_object' };
    }

    let freeFormPaths = new Map<string, string[][]>();
    if (options.tools && options.tools.length > 0) {
      const scanReport = scanAndAdaptToolsForProvider(options.tools, 'moonshot');
      payload['tools'] = scanReport.adaptedTools;
      payload['tool_choice'] = 'auto';
      freeFormPaths = scanReport.freeFormPaths;
    }

    const endpoint = this.baseUrl || 'https://api.moonshot.ai/v1/chat/completions';
    const requestOpts = {
      url: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      providerLabel: 'Moonshot AI',
      secrets: [apiKey],
      hasApiKey: true,
      allowInsecureHttp: this.allowInsecureHttp,
      onHttpError: ({ status }: { status: number }) => {
        let host = '';
        try { host = new URL(endpoint).hostname.toLowerCase(); } catch { host = ''; }
        if (status === 401 && (host === 'api.moonshot.ai' || host === 'api.moonshot.cn')) {
          const isGlobal = host === 'api.moonshot.ai';
          const altUrl = isGlobal
            ? 'https://api.moonshot.cn/v1/chat/completions'
            : 'https://api.moonshot.ai/v1/chat/completions';
          throw new Error(
            `Moonshot AI (Kimi) authentication failed (HTTP 401) against ${host}. ` +
            `If your API key belongs to the ${isGlobal ? 'China Mainland (.cn)' : 'Global (.ai)'} region, run \`causyne config\` and set Custom Base URL to: ${altUrl}`
          );
        }
      }
    };

    const data = wantsStreaming(options)
      ? await streamOpenAICompatibleChat({
          ...requestOpts,
          payload,
          onChunk: options.onChunk,
          onReasoningChunk: options.onReasoningChunk
        })
      : await safeProviderFetchJson({
          ...requestOpts,
          body: JSON.stringify(payload)
        });
    const normalized = normalizeOpenAIChatChoiceResponse(data, {
      prefix: 'call_moonshot',
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
