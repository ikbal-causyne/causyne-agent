import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import type { ProviderConfig } from './base.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig = {}) {
    super(config);
    if (!config.baseUrl) this.baseUrl = 'https://api.openai.com/v1/chat/completions';
    this.providerLabel = 'OpenAI';
    this.model = String(canonicalModelId(config.model || DEFAULT_MODEL_BY_PROVIDER['openai']) || '');
    this.visionModels = ['*'];
    this.imagePayloadFormat = 'openai';
    this.audioModels = ['gpt-4o-audio', 'gpt-4o-mini-audio', 'gpt-audio', 'gpt-realtime'];
    this.audioPayloadFormat = 'openai';
    this.preserveReasoningContent = false;
    const allowedEfforts = new Set(['low', 'medium', 'high', 'xhigh', 'minimal', 'none', 'off']);
    if (this.reasoningEffort && !allowedEfforts.has(this.reasoningEffort)) {
      this.reasoningEffort = null;
    }
  }

  override rejectsSamplingParameters(): boolean {
    const lowered = (this.model || '').trim().toLowerCase();
    if (/^o[134](?:$|[-.])/.test(lowered)) return true;
    if (/^gpt-[56](?:$|[-.])/.test(lowered) && !lowered.includes('-chat')) {
      return this.reasoningEffort !== 'none' && this.reasoningEffort !== 'off';
    }
    return false;
  }

  override usesMaxCompletionTokens(): boolean {
    const lowered = (this.model || '').trim().toLowerCase();
    return /^o[134](?:$|[-.])/.test(lowered) || /^gpt-[56](?:$|[-.])/.test(lowered);
  }

  override supportsPromptCacheKey(): boolean {
    if (!this.baseUrl) return false;
    try {
      const host = new URL(this.baseUrl).hostname.toLowerCase();
      return host === 'api.openai.com';
    } catch {
      return false;
    }
  }

  override supportsReasoningEffort(): boolean {
    const lowered = (this.model || '').trim().toLowerCase();
    return (/^o[134](?:$|[-.])/.test(lowered) || /^gpt-[56](?:$|[-.])/.test(lowered))
      && !lowered.includes('-chat');
  }
}
