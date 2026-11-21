/**
 * Causyne Agent — OpenRouter Free Provider
 *
 * Implements genuine zero-cost hosted model inference via the official
 * OpenRouter Free router (`openrouter/free`) and verified zero-cost models.
 * Enforces strict zero-cost boundaries, default data_collection: "deny",
 * streaming SSE, and safe tool-call parsing without paid model fallbacks.
 */

import { LLMProvider, type ChatOptions, type ChatResponse, type ChatResponseUsage, type ChatResponseToolCall } from './base.js';
import { canonicalModelId } from '../modelIds.js';
import { scanAndAdaptToolsForProvider, normalizeToolName } from '../tools/toolScanner.js';
import { stripToolCallMarkup } from '../implementationPlan.js';
import {
  extractTextToolCalls,
  normalizeOpenAIChatChoiceResponse,
  sanitizeProviderToolId,
  serializeAndDecodeArguments
} from './wireNormalizer.js';
import {
  MAX_PROVIDER_ERROR_BYTES,
  MAX_PROVIDER_JSON_BYTES,
  MAX_SSE_BUFFER_BYTES,
  ProviderHttpError,
  parseRetryAfterMs,
  readBoundedResponseText,
  redactProviderSecrets,
  resolveTemperature,
  safeProviderFetch
} from './byokHttp.js';
import { wantsStreaming } from './byokStream.js';

export const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
export const OPENROUTER_CHAT_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
export const OPENROUTER_DEFAULT_FREE_MODEL = 'openrouter/free';

export class FreeModeCostGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FreeModeCostGuardError';
  }
}

export class OpenRouterRateLimitError extends Error {
  public readonly status = 429;
  public readonly retryAfterMs?: number | undefined;

  constructor(message: string, retryAfterMs?: number | undefined) {
    super(message);
    this.name = 'OpenRouterRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class OpenRouterPrivacyConstraintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenRouterPrivacyConstraintError';
  }
}

export class OpenRouterProvider extends LLMProvider {
  public dataCollection: 'deny' | 'allow';
  public freeOnly: boolean;
  public allowInsecureHttp: boolean;

  constructor(config: Record<string, any> = {}) {
    super(config);
    this.baseUrl = config['baseUrl'] || OPENROUTER_CHAT_ENDPOINT;
    this.allowInsecureHttp = config['allowInsecureHttp'] === true;
    this.model = canonicalModelId(String(config['model'] || OPENROUTER_DEFAULT_FREE_MODEL));
    this.dataCollection = config['openrouterDataCollection'] === 'allow' ? 'allow' : 'deny';
    this.freeOnly = config['freeOnly'] !== false; // Default: free mode enforced

    // Verify model cost constraint upon instantiation
    if (this.freeOnly) {
      this.assertFreeModel(this.model);
    }
  }

  /**
   * Determine whether a model identifier represents a zero-cost free route.
   */
  public isFreeModel(modelId: string): boolean {
    const clean = (modelId || '').trim().toLowerCase();
    if (!clean || /[\s?#\x00-\x1f]/.test(clean)) return false;
    if (clean === 'openrouter/free' || clean === 'free') return true;
    if (clean.endsWith(':free')) {
      const slug = clean.slice(0, -5);
      return slug.length > 0 && !slug.startsWith('/') && !slug.endsWith('/');
    }
    return false;
  }

  /**
   * Enforce that the requested model is strictly zero-cost.
   */
  public assertFreeModel(modelId: string): void {
    if (!this.isFreeModel(modelId)) {
      throw new FreeModeCostGuardError(
        `Model '${modelId}' is not an authorized free model. Free mode strictly forbids paid models to prevent unintended charges.`
      );
    }
  }

  /**
   * Execute chat completion with OpenRouter, supporting streaming, tools, and privacy tags.
   */
  public override async chat(messages: any[], options: ChatOptions = {}): Promise<ChatResponse> {
    if (this.freeOnly) {
      this.assertFreeModel(this.model);
    }

    const apiKey = String(this.apiKey || process.env.OPENROUTER_API_KEY || '').trim();
    if (!apiKey) {
      throw new Error(
        'OpenRouter API key is required. Run /openrouter connect or /setup to connect your OpenRouter account.'
      );
    }

    const preparedMessages = this.prepareMessages(messages);
    const shouldStream = wantsStreaming(options);

    const payload: Record<string, any> = {
      model: this.model,
      messages: preparedMessages,
      temperature: resolveTemperature(options.temperature, 0.1),
      stream: shouldStream,
      ...(shouldStream ? { stream_options: { include_usage: true } } : {}),
      provider: {
        data_collection: this.dataCollection
      }
    };

    if (typeof options.maxTokens === 'number' && Number.isFinite(options.maxTokens) && options.maxTokens >= 1) {
      payload['max_tokens'] = Math.floor(options.maxTokens);
    }

    if (options['jsonMode']) {
      payload['response_format'] = { type: 'json_object' };
    }

    let freeFormPaths = new Map<string, string[][]>();
    if (options.tools && Array.isArray(options.tools) && options.tools.length > 0) {
      const scanReport = scanAndAdaptToolsForProvider(options.tools, 'openai');
      payload['tools'] = scanReport.adaptedTools;
      payload['tool_choice'] = 'auto';
      freeFormPaths = scanReport.freeFormPaths;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://causyne.com',
      'X-Title': 'Causyne Agent'
    };

    const endpoint = this.baseUrl || OPENROUTER_CHAT_ENDPOINT;
    const { response, cleanup } = await safeProviderFetch({
      url: endpoint,
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: options.signal,
      timeoutMs: typeof options['timeoutMs'] === 'number' ? options['timeoutMs'] : undefined,
      providerLabel: 'OpenRouter',
      secrets: [apiKey],
      hasApiKey: true,
      allowInsecureHttp: this.allowInsecureHttp
    });

    try {
      if (!response.ok) {
        const rawError = await readBoundedResponseText(response, MAX_PROVIDER_ERROR_BYTES, {
          truncate: true,
          label: 'OpenRouter'
        }).catch(() => '');
        const cleanError = redactProviderSecrets(rawError, [apiKey]);
        const retryAfterHeader = (response as unknown as { headers?: { get?: (k: string) => string | null } }).headers?.get?.('retry-after');
        const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
        this.handleHttpErrors(response.status, cleanError, retryAfterMs);
      }

      if (shouldStream && response.body) {
        return await this.handleStreamingResponse(response, options, freeFormPaths);
      } else {
        return await this.handleJsonResponse(response, freeFormPaths, apiKey);
      }
    } finally {
      cleanup();
    }
  }

  /**
   * Map HTTP error codes into user-friendly and security-preserving exceptions.
   */
  private handleHttpErrors(status: number, errorText: string, retryAfterMs?: number): never {
    if (status === 429) {
      const retryNote = retryAfterMs !== undefined
        ? ` Retry after ${Math.ceil(retryAfterMs / 1000)}s.`
        : '';
      throw new OpenRouterRateLimitError(
        `OpenRouter Free rate limit or quota exceeded. Free models have community concurrency limits. Please wait a moment or try again later.${retryNote}`,
        retryAfterMs
      );
    }

    const lowered = (errorText || '').toLowerCase();
    if (status === 400 || status === 404) {
      if (lowered.includes('data_collection') || lowered.includes('no provider available') || lowered.includes('data policy')) {
        throw new OpenRouterPrivacyConstraintError(
          `No free provider is currently available matching the privacy policy (data_collection='${this.dataCollection}'). ` +
          `Free community models on OpenRouter typically require data collection. ` +
          `Run "/openrouter allow" to permit free model routing, or inspect your preference with /openrouter status.`
        );
      }
      if (lowered.includes('rate limit') || lowered.includes('free model quota')) {
        throw new OpenRouterRateLimitError(
          'OpenRouter Free usage limit reached for this free model. Please wait a moment or select another free model with /model.',
          retryAfterMs
        );
      }
    }

    throw new Error(`OpenRouter API Error (${status}): ${errorText}`);
  }

  /**
   * Process a non-streaming JSON response from OpenRouter.
   */
  private async handleJsonResponse(
    response: Response,
    freeFormPaths?: Map<string, string[][]>,
    apiKey?: string
  ): Promise<ChatResponse> {
    let data: any;
    if (!response.body && typeof response.text !== 'function' && typeof response.json === 'function') {
      data = await response.json();
    } else {
      const rawText = await readBoundedResponseText(response, MAX_PROVIDER_JSON_BYTES, {
        truncate: false,
        label: 'OpenRouter'
      });
      try {
        data = JSON.parse(rawText);
      } catch {
        const preview = redactProviderSecrets(rawText.slice(0, 240), [apiKey]);
        throw new Error(`OpenRouter returned a non-JSON response (HTTP ${response.status}): ${preview}`);
      }
    }
    const normalized = normalizeOpenAIChatChoiceResponse(data, {
      prefix: 'call_openrouter',
      ...(freeFormPaths ? { freeFormPaths } : {})
    });
    const usage: ChatResponseUsage = this.normalizeUsage(normalized.rawUsage);

    return {
      content: normalized.content,
      toolCalls: normalized.toolCalls,
      reasoningContent: normalized.reasoningContent,
      usage
    };
  }

  /**
   * Process a streaming SSE response from OpenRouter.
   */
  private async handleStreamingResponse(
    response: Response,
    options: ChatOptions,
    freeFormPaths?: Map<string, string[][]>
  ): Promise<ChatResponse> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder('utf-8');

    let content = '';
    let reasoningContent = '';
    let buffer = '';
    const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();
    let rawUsage: any = null;

    const processLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) return; // Skip comments/keepalive
      if (trimmed === 'data: [DONE]' || trimmed === 'data:[DONE]') return;

      if (trimmed.startsWith('data:')) {
        const jsonStr = trimmed.slice(5).replace(/^ /, '');
        let parsed: any;
        try {
          parsed = JSON.parse(jsonStr);
        } catch {
          return;
        }

        if (parsed.usage) {
          rawUsage = parsed.usage;
        }

        const choice = parsed.choices?.[0];
        if (!choice) return;

        const delta = choice.delta;
        if (delta) {
          // 1. Text chunk
          if (delta.content) {
            content += delta.content;
            if (options.onChunk) {
              options.onChunk(delta.content);
            }
          }

          // 2. Reasoning chunk
          const reasoning = delta.reasoning || delta.reasoning_content;
          if (reasoning) {
            reasoningContent += reasoning;
            if (options.onReasoningChunk) {
              options.onReasoningChunk(reasoning);
            }
          }

          // 3. Tool calls assembly
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = typeof tc.index === 'number' ? tc.index : toolCallsMap.size;
              let existing = toolCallsMap.get(idx);
              if (!existing) {
                existing = { id: tc.id || `call_${idx}_${Date.now()}`, name: '', arguments: '' };
                toolCallsMap.set(idx, existing);
              }
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name += tc.function.name;
              if (tc.function?.arguments) existing.arguments += tc.function.arguments;
            }
          }
        }
      }
    };

    try {
      while (true) {
        if (options.signal?.aborted) {
          await reader.cancel().catch(() => {});
          const abortErr = new Error('OpenRouter request aborted');
          abortErr.name = 'AbortError';
          throw abortErr;
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_BUFFER_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error(`OpenRouter SSE buffer exceeded maximum allowed size (${MAX_SSE_BUFFER_BYTES} bytes).`);
        }
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          processLine(line);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        for (const line of buffer.split('\n')) {
          processLine(line);
        }
      }
    } finally {
      reader.releaseLock();
    }

    const toolCalls: ChatResponseToolCall[] = [];
    for (const item of toolCallsMap.values()) {
      if (item.name) {
        const cleanName = normalizeToolName(item.name);
        toolCalls.push({
          id: item.id,
          type: 'function',
          function: {
            name: cleanName,
            arguments: serializeAndDecodeArguments(item.arguments || '{}', cleanName, freeFormPaths)
          }
        });
      }
    }

    if (toolCalls.length === 0 && content) {
      const extracted = extractTextToolCalls(content, 'call_text', freeFormPaths);
      if (extracted.length > 0) {
        toolCalls.push(...extracted);
      }
    }

    const usage: ChatResponseUsage = this.normalizeUsage(
      rawUsage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    );

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      reasoningContent: reasoningContent || undefined,
      usage
    };
  }
}
