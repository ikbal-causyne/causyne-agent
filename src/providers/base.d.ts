export interface ProviderConfig {
  apiKey?: string | undefined;
  model?: string | undefined;
  baseUrl?: string | undefined;
  provider?: string | undefined;
  command?: string | undefined;
  args?: string[] | undefined;
  peer?: string | undefined;
  supportsVision?: boolean | undefined;
  [key: string]: any;
}

export interface ChatResponseUsage {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens?: number | undefined;
  measurement?: 'provider_reported' | 'text_estimate' | undefined;
  cacheMeasurement?: 'provider_reported' | 'unavailable' | undefined;
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
}

export interface ChatResponseAction {
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
  incompleteTurn?: boolean | undefined;
}

export interface ChatOptions {
  tools?: any[] | undefined;
  temperature?: number | undefined;
  maxRetries?: number | undefined;
  signal?: AbortSignal | undefined;
  onChunk?: ((chunk: string) => void) | undefined;
  onReasoningChunk?: ((chunk: string) => void) | undefined;
  onNativeAction?: ((action: ChatResponseAction) => void) | undefined;
  coreToolCount?: number | undefined;
  [key: string]: any;
}

export class LLMProvider {
  apiKey?: string;
  model: string;
  baseUrl?: string;
  visionModels: string[];
  imagePayloadFormat: string;
  visionOverride: boolean | null;
  audioModels: string[];
  audioPayloadFormat: string;

  constructor(config?: ProviderConfig);
  get supportsVision(): boolean;
  get supportsAudio(): boolean;
  supportsToolSearch?(): boolean;
  chat(messages: any[], options?: ChatOptions): Promise<ChatResponse>;
}

export function mimeTypeForAudioFormat(format: string): string;
export function audioFormatForMimeType(mimeType: string): string;
export function isAudioBlock(block: any): boolean;
