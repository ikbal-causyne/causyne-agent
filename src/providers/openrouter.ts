/**
 * Causyne Agent — OpenRouter Free Provider
 *
 * Implements genuine zero-cost hosted model inference via the official
 * OpenRouter Free router (`openrouter/free`) and verified zero-cost models.
 * Enforces strict zero-cost boundaries, default data_collection: "deny",
 * streaming SSE, and safe tool-call parsing without paid model fallbacks.
 */

import { LLMProvider } from './base.js';
import { canonicalModelId } from '../modelIds.js';
import { scanAndAdaptToolsForProvider } from '../tools/toolScanner.js';
import { extractToolCallJsonObjects, resolveToolCallEnvelopeArguments } from '../implementationPlan.js';
import type { ChatOptions, ChatResponse, ChatResponseUsage, ChatResponseToolCall } from './base.d.js';

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
  constructor(message: string) {
    super(message);
    this.name = 'OpenRouterRateLimitError';
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

  constructor(config: Record<string, any> = {}) {
    super(config);
    this.baseUrl = config['baseUrl'] || OPENROUTER_CHAT_ENDPOINT;
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
    if (clean === 'openrouter/free' || clean === 'free') return true;
    if (clean.endsWith(':free')) return true;
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

    const apiKey = this.apiKey || process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error(
        'OpenRouter API key is required. Run /openrouter connect or /setup to connect your OpenRouter account.'
      );
    }

    const preparedMessages = this.prepareMessages(messages);
    const shouldStream = typeof options.onChunk === 'function';

    const payload: Record<string, any> = {
      model: this.model,
      messages: preparedMessages,
      temperature: options.temperature ?? 0.1,
      stream: shouldStream,
      provider: {
        data_collection: this.dataCollection
      }
    };

    if (options['jsonMode']) {
      payload['response_format'] = { type: 'json_object' };
    }

    if (options.tools && Array.isArray(options.tools) && options.tools.length > 0) {
      const scanReport = scanAndAdaptToolsForProvider(options.tools, 'openai');
      payload['tools'] = scanReport.adaptedTools;
      payload['tool_choice'] = 'auto';
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://causyne.com',
      'X-Title': 'Causyne Agent'
    };

    let response: Response;
    const endpoint = this.baseUrl || OPENROUTER_CHAT_ENDPOINT;
    const fetchInit: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    };
    if (options.signal) {
      fetchInit.signal = options.signal;
    }

    try {
      response = await fetch(endpoint, fetchInit);
    } catch (err: any) {
      if (err?.name === 'AbortError' || options.signal?.aborted) {
        throw err;
      }
      throw new Error(`OpenRouter network connection error: ${err?.message || err}`);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      this.handleHttpErrors(response.status, errorText);
    }

    if (shouldStream && response.body) {
      return this.handleStreamingResponse(response, options);
    } else {
      return this.handleJsonResponse(response);
    }
  }

  /**
   * Map HTTP error codes into user-friendly and security-preserving exceptions.
   */
  private handleHttpErrors(status: number, errorText: string): never {
    if (status === 429) {
      throw new OpenRouterRateLimitError(
        'OpenRouter Free rate limit or quota exceeded. Free models have community concurrency limits. Please wait a moment or try again later.'
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
          'OpenRouter Free usage limit reached for this free model. Please wait a moment or select another free model with /model.'
        );
      }
    }

    throw new Error(`OpenRouter API Error (${status}): ${errorText}`);
  }

  /**
   * Process a non-streaming JSON response from OpenRouter.
   */
  private async handleJsonResponse(response: Response): Promise<ChatResponse> {
    const data = (await response.json()) as any;
    let content = '';
    let toolCalls: ChatResponseToolCall[] = [];
    let reasoningContent = '';

    if (data.choices && Array.isArray(data.choices) && data.choices[0]?.message) {
      const message = data.choices[0].message;
      content = message.content || '';
      toolCalls = this.normalizeToolCalls(message.tool_calls);
      reasoningContent = message.reasoning || message.reasoning_content || '';
    }

    if (toolCalls.length === 0 && content) {
      const extracted = this.extractToolCallsFromContent(content);
      if (extracted.length > 0) {
        toolCalls = extracted;
      }
    }

    const rawUsage = data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const usage: ChatResponseUsage = this.normalizeUsage(rawUsage);

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      reasoningContent: reasoningContent || undefined,
      usage
    };
  }

  /**
   * Process a streaming SSE response from OpenRouter.
   */
  private async handleStreamingResponse(response: Response, options: ChatOptions): Promise<ChatResponse> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder('utf-8');

    let content = '';
    let reasoningContent = '';
    let buffer = '';
    const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();
    let rawUsage: any = null;

    try {
      while (true) {
        if (options.signal?.aborted) {
          await reader.cancel().catch(() => {});
          break;
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue; // Skip comments/keepalive
          if (trimmed === 'data: [DONE]') continue;

          if (trimmed.startsWith('data: ')) {
            const jsonStr = trimmed.slice(6);
            let parsed: any;
            try {
              parsed = JSON.parse(jsonStr);
            } catch {
              continue;
            }

            if (parsed.usage) {
              rawUsage = parsed.usage;
            }

            const choice = parsed.choices?.[0];
            if (!choice) continue;

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
        }
      }
    } finally {
      reader.releaseLock();
    }

    const toolCalls: ChatResponseToolCall[] = [];
    for (const item of toolCallsMap.values()) {
      if (item.name) {
        toolCalls.push({
          id: item.id,
          type: 'function',
          function: {
            name: item.name,
            arguments: item.arguments || '{}'
          }
        });
      }
    }

    if (toolCalls.length === 0 && content) {
      const extracted = this.extractToolCallsFromContent(content);
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

  /**
   * Extract tool calls embedded in content text (e.g. <tool_call> envelopes).
   */
  private extractToolCallsFromContent(text: string): ChatResponseToolCall[] {
    const calls: ChatResponseToolCall[] = [];
    if (!text || typeof text !== 'string') return calls;
    let index = 0;
    for (const parsed of extractToolCallJsonObjects(text)) {
      const fnObj = parsed.function && typeof parsed.function === 'object'
        ? (parsed.function as Record<string, unknown>)
        : null;
      const name = String(parsed.name || parsed.tool || fnObj?.name || '').trim();
      if (!name) continue;
      const rawArgs = resolveToolCallEnvelopeArguments(parsed);
      calls.push({
        id: `call_text_${Date.now()}_${index++}`,
        type: 'function',
        function: {
          name,
          arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs || {})
        }
      });
    }
    return calls;
  }

  /**
   * Safely normalize tool calls from provider message.
   */
  private normalizeToolCalls(rawCalls: any[]): ChatResponseToolCall[] {
    if (!Array.isArray(rawCalls)) return [];
    const normalized: ChatResponseToolCall[] = [];

    for (let i = 0; i < rawCalls.length; i++) {
      const tc = rawCalls[i];
      if (!tc || typeof tc !== 'object') continue;

      const id = typeof tc.id === 'string' && tc.id ? tc.id : `call_${i}_${Date.now()}`;
      const name = tc.function?.name || tc.name || '';
      if (!name || typeof name !== 'string') continue;

      let args = tc.function?.arguments;
      if (typeof args !== 'string') {
        try {
          args = JSON.stringify(args || {});
        } catch {
          args = '{}';
        }
      }

      normalized.push({
        id,
        type: 'function',
        function: {
          name,
          arguments: args
        }
      });
    }

    return normalized;
  }
}
