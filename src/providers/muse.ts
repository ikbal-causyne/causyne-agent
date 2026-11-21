import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import type { ProviderConfig } from './base.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { safeProviderFetchJson } from './byokHttp.js';

export const MUSE_BASE_URL = 'https://api.meta.ai/v1';
export const MUSE_CONTEXT_TOKENS = 1_048_576;
export const MUSE_IMAGE_MODEL = 'muse-image-1.0';
export const MUSE_TRANSCRIBE_MODEL = 'muse-voice-transcribe-1.0';

export interface MuseChatModelSpec {
  id: string;
  tier: 'standard' | 'contributor';
  audio: boolean;
  recommended?: boolean;
}

export const MUSE_CHAT_MODELS: readonly MuseChatModelSpec[] = [
  { id: 'muse-spark-1.3', tier: 'standard', audio: false, recommended: true },
  { id: 'muse-spark-1.3-contributor', tier: 'contributor', audio: false },
  { id: 'muse-spark-1.2', tier: 'standard', audio: true },
  { id: 'muse-spark-1.2-contributor', tier: 'contributor', audio: true },
  { id: 'muse-spark-1.1', tier: 'standard', audio: true }
];

const AUDIO_CAPABLE: string[] = MUSE_CHAT_MODELS.filter((m) => m.audio).map((m) => m.id);

export function isContributorModel(model: unknown): boolean {
  return String(model || '').toLowerCase().endsWith('-contributor');
}

const VALID_MUSE_EFFORTS = new Set(['low', 'medium', 'high', 'max', 'off']);

export function clampReasoningEffort(effort: unknown, model: unknown): string | null {
  const requested = String(effort || '').trim().toLowerCase();
  if (!requested || !VALID_MUSE_EFFORTS.has(requested)) return null;
  if (requested === 'off') return 'off';
  if (requested === 'max' && isContributorModel(model)) return 'high';
  return requested;
}

export class MuseProvider extends OpenAICompatibleProvider {
  contextTokens: number;

  constructor(config: ProviderConfig = {}) {
    super(config);

    if (!config.baseUrl) this.baseUrl = `${MUSE_BASE_URL}/chat/completions`;
    this.providerLabel = 'Meta (Muse)';
    this.model = String(canonicalModelId(config.model || DEFAULT_MODEL_BY_PROVIDER['muse']) || '');
    this.visionModels = ['muse-spark'];
    this.imagePayloadFormat = 'openai';
    this.audioModels = AUDIO_CAPABLE;
    this.audioPayloadFormat = 'openai';
    this.maxAudioSeconds = null;
    this.maxAudioBytes = null;
    this.contextTokens = MUSE_CONTEXT_TOKENS;
    this.reasoningEffort = clampReasoningEffort(config.reasoningEffort, this.model);
  }

  override audioAlternative(): string | null {
    if (this.supportsAudio) return null;
    return isContributorModel(this.model) ? 'muse-spark-1.2-contributor' : 'muse-spark-1.2';
  }

  get transcribeModel(): string {
    return MUSE_TRANSCRIBE_MODEL;
  }

  get transcribeUrl(): string {
    return `${MUSE_BASE_URL}/asr/transcribe`;
  }

  override get canTranscribe(): boolean {
    return Boolean(this.apiKey) && process.env.CAUSYNE_MUSE_ASR === '1';
  }

  override async transcribeAudio(
    base64?: string,
    mimeType = 'audio/wav',
    options: Record<string, any> = {}
  ): Promise<string | null> {
    if (!base64 || !this.apiKey) return null;

    const extension = String(mimeType).includes('mp3') ? 'mp3'
      : String(mimeType).includes('mp4') || String(mimeType).includes('m4a') ? 'm4a'
      : String(mimeType).includes('ogg') ? 'ogg'
      : String(mimeType).includes('webm') ? 'webm'
      : 'wav';

    const form = new FormData();
    form.append('model', MUSE_TRANSCRIBE_MODEL);
    form.append('file', new Blob([Buffer.from(base64, 'base64')], { type: mimeType }), `clip.${extension}`);

    const data: Record<string, any> = await safeProviderFetchJson({
      url: this.transcribeUrl,
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: options['signal'],
      timeoutMs: options['timeoutMs'],
      providerLabel: 'Muse Voice Transcribe',
      secrets: [this.apiKey],
      hasApiKey: true
    });
    const text = data['text']
      || data['transcript']
      || (Array.isArray(data['turns']) ? data['turns'].map((t: any) => t.text).filter(Boolean).join(' ') : '');
    return String(text || '').trim() || null;
  }
}
