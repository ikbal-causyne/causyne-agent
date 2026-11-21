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
  }

  override rejectsSamplingParameters(): boolean {
    const lowered = (this.model || '').trim().toLowerCase();
    return /^o[134](?:$|[-.])/.test(lowered);
  }

  override usesMaxCompletionTokens(): boolean {
    return this.rejectsSamplingParameters();
  }
}
