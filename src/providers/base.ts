import { canonicalModelId } from '../modelIds.js';
import type { RequestPermissionRequest, RequestPermissionResponse } from '../acp/protocol.js';

export interface ProviderConfig {
  apiKey?: string | undefined;
  model?: string | undefined;
  baseUrl?: string | undefined;
  provider?: string | undefined;
  command?: string | undefined;
  args?: string[] | undefined;
  peer?: string | undefined;
  supportsVision?: boolean | undefined;
  supportsAudio?: boolean | undefined;
  allowInsecureHttp?: boolean | undefined;
  reasoningEffort?: string | null | undefined;
  showReasoning?: boolean | undefined;
  reasoningBudgetTokens?: number | null | undefined;
  enableToolSearch?: boolean | undefined;
  enablePromptCaching?: boolean | undefined;
  promptCacheTtl?: string | undefined;
  [key: string]: any;
}

export interface ChatResponseUsage {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens?: number | undefined;
  uncachedPromptTokens?: number | undefined;
  cacheWriteMultiplier?: number | undefined;
  cacheWriteTokens?: number | undefined;
  measurement?: 'provider_reported' | 'text_estimate' | undefined;
  cacheMeasurement?: 'provider_reported' | 'unavailable' | undefined;
  measurementScope?: 'last_model_call' | 'peer_reported' | undefined;
  totalTokens?: number | undefined;
  thinkingTokens?: number | undefined;
}

export interface ChatResponseToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
  thoughtSignature?: string | undefined;
}

export interface ChatResponseAction {
  id?: string | undefined;
  name: string;
  status: 'running' | 'completed' | 'failed';
  detail?: string | undefined;
  parameters?: Record<string, unknown> | undefined;
}

export interface ChatResponse {
  content: string;
  usage: ChatResponseUsage;
  toolCalls?: ChatResponseToolCall[] | undefined;
  reasoningContent?: string | undefined;
  thinkingBlocks?: any[] | undefined;
  externalActions?: ChatResponseAction[] | undefined;
  toolRoutingError?: { tool: string; message: string; parameters?: Record<string, unknown> | undefined } | undefined;
  incompleteTurn?: boolean | undefined;
}

export interface ChatOptions {
  onPeerPermission?: ((request: RequestPermissionRequest) => Promise<RequestPermissionResponse['outcome']>) | undefined;
  onPeerFileRead?: ((file: string, options?: { line?: number; limit?: number }) => Promise<string>) | undefined;
  onPeerFileWrite?: ((file: string, content: string) => Promise<void>) | undefined;
  peerMcpServers?: unknown[] | undefined;
  tokenBudgetBasis?: 'total' | 'noncached' | undefined;
  tools?: any[] | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  jsonMode?: boolean | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  signal?: AbortSignal | undefined;
  onChunk?: ((chunk: string) => void) | undefined;
  onReasoningChunk?: ((chunk: string) => void) | undefined;
  onNativeAction?: ((action: ChatResponseAction) => void) | undefined;
  onPlanUpdate?: ((plan: unknown) => void) | undefined;
  coreToolCount?: number | undefined;
  [key: string]: any;
}

// Fields the agent loop attaches to messages for its own bookkeeping. They must
// never reach a provider API, which rejects unknown message properties.
const INTERNAL_MESSAGE_FIELDS: readonly string[] = ['cacheAnchor', 'spillPath'];

// Container formats each vendor accepts for audio input.
const AUDIO_MIME_BY_FORMAT: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  webm: 'audio/webm'
};

/** Map a container format token to the MIME type a provider expects. */
export function mimeTypeForAudioFormat(format: unknown): string {
  const key = String(format || '').trim().toLowerCase();
  return Object.hasOwn(AUDIO_MIME_BY_FORMAT, key) ? AUDIO_MIME_BY_FORMAT[key]! : 'audio/wav';
}

/**
 * Map a MIME type to the short format token OpenAI's input_audio expects.
 */
export function audioFormatForMimeType(mimeType: unknown): string {
  const mime = String(mimeType || '').toLowerCase().split(';')[0]?.trim() || '';
  for (const [format, candidate] of Object.entries(AUDIO_MIME_BY_FORMAT)) {
    if (candidate === mime) return format;
  }
  if (mime === 'audio/mp3' || mime === 'audio/x-mpeg') return 'mp3';
  if (mime === 'audio/x-wav' || mime === 'audio/wave') return 'wav';
  if (mime === 'audio/x-m4a') return 'm4a';
  if (mime === 'audio/x-flac') return 'flac';
  if (mime === 'audio/x-aac') return 'aac';
  return 'wav';
}

/** True for an audio content block in either the OpenAI or the Gemini shape. */
export function isAudioBlock(block: any): boolean {
  if (!block || typeof block !== 'object') return false;
  if (block.type === 'input_audio') return true;
  return Boolean(block.inlineData && String(block.inlineData.mimeType || '').startsWith('audio/'));
}

export class LLMProvider {
  apiKey?: string | undefined;
  model: string;
  baseUrl?: string | undefined;
  visionModels: string[];
  imagePayloadFormat: string;
  visionOverride: boolean | null;
  audioModels: string[];
  audioPayloadFormat: string;
  maxAudioSeconds: number | null;
  maxAudioBytes: number | null;
  audioOverride: boolean | null;
  preserveThinkingBlocks: boolean;
  preserveReasoningContent: boolean;

  constructor(config?: ProviderConfig | null) {
    const cfg: ProviderConfig = config && typeof config === 'object' ? config : {};
    this.apiKey = cfg.apiKey;
    this.model = String(canonicalModelId(cfg.model ?? '') || '');
    this.baseUrl = cfg.baseUrl;
    this.visionModels = [];
    this.imagePayloadFormat = 'openai';
    this.visionOverride = typeof cfg.supportsVision === 'boolean'
      ? cfg.supportsVision
      : null;
    this.audioModels = [];
    this.audioPayloadFormat = 'openai';
    this.maxAudioSeconds = null;
    this.maxAudioBytes = null;
    this.audioOverride = typeof cfg.supportsAudio === 'boolean'
      ? cfg.supportsAudio
      : null;
    this.preserveThinkingBlocks = false;
    this.preserveReasoningContent = true;
  }

  get supportsVision(): boolean {
    if (this.visionOverride !== null) return this.visionOverride;
    const model = (this.model || '').toLowerCase();
    return this.visionModels.some(prefix => prefix === '*' || model.includes(prefix));
  }

  audioAlternative(): string | null {
    return null;
  }

  async transcribeAudio(_base64?: string, _mimeType?: string, _options?: Record<string, any>): Promise<string | null> {
    return null;
  }

  get canTranscribe(): boolean {
    return false;
  }

  get supportsAudio(): boolean {
    if (this.audioOverride !== null) return this.audioOverride;
    const model = (this.model || '').toLowerCase();
    return this.audioModels.some(prefix => prefix === '*' || model.includes(prefix));
  }

  async chat(_messages: any[], _options: ChatOptions = {}): Promise<ChatResponse> {
    throw new Error('chat() must be implemented by provider');
  }

  prepareMessages(messages: any[]): any[] {
    const clean = this.stripInternalFields(messages);

    const shaped = this.supportsVision
      ? clean.map(msg => this.normalizeImageBlocks(msg))
      : clean.map(msg => this.flattenToTextOnly(msg));

    return this.supportsAudio
      ? shaped.map(msg => this.normalizeAudioBlocks(msg))
      : shaped.map(msg => this.stripAudioBlocks(msg));
  }

  normalizeAudioBlocks(msg: any): any {
    if (!Array.isArray(msg.content)) return msg;

    const content = msg.content.map((block: any) => {
      if (!block || typeof block !== 'object') return block;

      if (this.audioPayloadFormat === 'gemini') {
        if (block.type === 'input_audio') {
          return {
            inlineData: {
              mimeType: mimeTypeForAudioFormat(block.input_audio?.format),
              data: block.input_audio?.data
            }
          };
        }
        return block;
      }

      if (block.inlineData && String(block.inlineData.mimeType || '').startsWith('audio/')) {
        return {
          type: 'input_audio',
          input_audio: {
            data: block.inlineData.data,
            format: audioFormatForMimeType(block.inlineData.mimeType)
          }
        };
      }
      return block;
    });

    return { ...msg, content };
  }

  stripAudioBlocks(msg: any): any {
    if (!Array.isArray(msg.content)) return msg;
    if (!msg.content.some(isAudioBlock)) return msg;

    const content = msg.content
      .filter((block: any) => !isAudioBlock(block))
      .concat([{
        type: 'text',
        text: '[Audio content removed — the selected model cannot process audio. Causyne transcribed the request on-device instead where possible.]'
      }]);

    return { ...msg, content };
  }

  normalizeImageBlocks(msg: any): any {
    if (!Array.isArray(msg.content)) return msg;
    if (this.imagePayloadFormat === 'anthropic') {
      const content = msg.content.map((block: any) => {
        if (block && block.type === 'image_url' && typeof block.image_url?.url === 'string') {
          const commaIdx = block.image_url.url.indexOf('base64,');
          if (commaIdx !== -1 && block.image_url.url.startsWith('data:')) {
            const rawMedia = (block.image_url.url.slice(5, commaIdx).split(';')[0] || 'image/png').trim().toLowerCase();
            const mediaType = rawMedia === 'image/jpg' ? 'image/jpeg' : rawMedia;
            const data = block.image_url.url.slice(commaIdx + 7);
            if (data) return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
          }
        }
        return block;
      });
      return { ...msg, content };
    }
    if (this.imagePayloadFormat !== 'openai') return msg;

    const content = msg.content.map((block: any) => {
      if (block && block.type === 'image' && block.source?.type === 'base64' && typeof block.source.data === 'string' && block.source.data) {
        const mime = typeof block.source.media_type === 'string' && block.source.media_type ? block.source.media_type : 'image/png';
        return {
          type: 'image_url',
          image_url: { url: `data:${mime};base64,${block.source.data}` }
        };
      }
      return block;
    });

    return { ...msg, content };
  }

  flattenToTextOnly(msg: any): any {
    if (!Array.isArray(msg.content)) return msg;

    const audioBlocks = this.supportsAudio ? msg.content.filter(isAudioBlock) : [];

    const textParts = msg.content
      .filter((block: any) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
      .map((block: any) => block.text);

    const text = textParts.join('\n') ||
      '[Image content removed — not supported by this model]';

    if (audioBlocks.length === 0) return { ...msg, content: text };

    return { ...msg, content: [{ type: 'text', text }, ...audioBlocks] };
  }

  stripInternalFields(messages: any[]): any[] {
    if (!Array.isArray(messages)) return [];
    const fieldsToStrip: string[] = [...INTERNAL_MESSAGE_FIELDS, 'thoughtSignature'];
    if (!this.preserveThinkingBlocks) fieldsToStrip.push('thinking_blocks');
    if (!this.preserveReasoningContent) fieldsToStrip.push('reasoning_content');
    return messages.filter((msg) => msg && typeof msg === 'object').map(msg => {
      let needsCopy = false;
      for (const field of fieldsToStrip) {
        if (field in msg) { needsCopy = true; break; }
      }
      if (!needsCopy) return msg;

      const clean = { ...msg };
      for (const field of fieldsToStrip) delete clean[field];
      return clean;
    });
  }

  normalizeUsage(rawUsage: any): ChatResponseUsage {
    const nonNeg = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
    const promptTokens = nonNeg(rawUsage?.prompt_tokens);
    const completionTokens = nonNeg(rawUsage?.completion_tokens);
    const rawCached =
      rawUsage?.prompt_tokens_details?.cached_tokens ??
      rawUsage?.prompt_cache_hit_tokens ??
      rawUsage?.cache_read_input_tokens ??
      0;
    const cachedPromptTokens = Math.min(nonNeg(rawCached), promptTokens);

    return {
      promptTokens,
      completionTokens,
      cachedPromptTokens
    };
  }
}
