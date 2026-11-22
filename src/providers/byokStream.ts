/**
 * Causyne Agent — Hardened Real-Time SSE & NDJSON Streaming for BYOK Providers
 *
 * Brings real-time token & reasoning streaming (`onChunk`, `onReasoningChunk`)
 * to all BYOK providers (OpenAI / OpenAI-Compatible / Muse, Anthropic, Gemini,
 * DeepSeek, xAI, Moonshot, Qwen, DashScope, and Ollama) while inheriting every
 * transport guarantee from `byokHttp.ts`:
 *   - Endpoint URL validation & `redirect: 'error'`
 *   - Cooperative AbortSignal (`Esc` / `/stop`) + bounded timeout
 *   - Strict SSE/NDJSON line buffer cap (4 MiB) & total stream cap (32 MiB)
 *   - Secret redaction, ANSI sanitization & `Retry-After` preservation
 *   - Graceful fallback when an upstream proxy returns non-streaming JSON
 */

import { safeParseJsonObject } from './wireNormalizer.js';
import {
  MAX_PROVIDER_ERROR_BYTES,
  MAX_PROVIDER_JSON_BYTES,
  MAX_SSE_BUFFER_BYTES,
  ProviderHttpError,
  parseRetryAfterMs,
  readBoundedResponseText,
  redactProviderSecrets,
  safeProviderFetch,
  type SafeProviderFetchJsonOptions
} from './byokHttp.js';

export interface ByokStreamCallbacks {
  onChunk?: ((delta: string) => void) | undefined;
  onReasoningChunk?: ((delta: string) => void) | undefined;
}

export interface StreamFetchOptions extends SafeProviderFetchJsonOptions {
  onChunk?: ((delta: string) => void) | undefined;
  onReasoningChunk?: ((delta: string) => void) | undefined;
}

export function wantsStreaming(options: unknown): boolean {
  if (!options || typeof options !== 'object') return false;
  const candidate = options as { onChunk?: unknown; onReasoningChunk?: unknown };
  return typeof candidate.onChunk === 'function' || typeof candidate.onReasoningChunk === 'function';
}

function getHeader(response: Response, name: string): string {
  const headers = (response as unknown as { headers?: { get?: (k: string) => string | null } }).headers;
  if (headers && typeof headers.get === 'function') {
    return headers.get(name) ?? '';
  }
  return '';
}

function isJsonContentType(contentType: string): boolean {
  const mediaType = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  return mediaType === 'application/json' || mediaType.endsWith('+json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function openHardenedStream(
  options: StreamFetchOptions
): Promise<
  | { mode: 'json'; data: Record<string, unknown> }
  | { mode: 'stream'; response: Response; cleanup: () => void }
> {
  const { response, cleanup } = await safeProviderFetch(options);

  if (!response.ok) {
    try {
      const rawError = await readBoundedResponseText(
        response,
        options.maxErrorBytes ?? MAX_PROVIDER_ERROR_BYTES,
        { truncate: true, label: options.providerLabel }
      ).catch(() => '');
      const cleanError = redactProviderSecrets(rawError, options.secrets);
      const retryAfterMs = parseRetryAfterMs(getHeader(response, 'retry-after') || null);

      if (options.onHttpError) {
        options.onHttpError({
          status: response.status,
          errorText: cleanError,
          retryAfterMs,
          response
        });
      }

      const retryNote = retryAfterMs !== undefined
        ? ` (retry after ${Math.ceil(retryAfterMs / 1000)}s)`
        : '';
      throw new ProviderHttpError(
        `${options.providerLabel} API Error (${response.status})${retryNote}: ${cleanError}`,
        { status: response.status, retryAfterMs }
      );
    } finally {
      cleanup();
    }
  }

  const contentType = getHeader(response, 'content-type');
  const hasStreamReader = Boolean(response.body && typeof response.body.getReader === 'function');

  // If the endpoint responded with regular JSON (or a minimal unit-test mock without a stream),
  // parse it safely rather than failing stream consumption.
  if (!hasStreamReader || isJsonContentType(contentType)) {
    try {
      if (!hasStreamReader && typeof response.text !== 'function' && typeof response.json === 'function') {
        const parsed = await response.json();
        return { mode: 'json', data: isRecord(parsed) ? parsed : {} };
      }
      const rawText = await readBoundedResponseText(
        response,
        options.maxBytes ?? MAX_PROVIDER_JSON_BYTES,
        { truncate: false, label: options.providerLabel }
      );
      const cleanText = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;
      try {
        const parsed: unknown = JSON.parse(cleanText);
        return { mode: 'json', data: isRecord(parsed) ? parsed : {} };
      } catch {
        const preview = redactProviderSecrets(rawText.slice(0, 240), options.secrets);
        throw new Error(
          `${options.providerLabel} returned a non-JSON response (HTTP ${response.status}): ${preview}`
        );
      }
    } finally {
      cleanup();
    }
  }

  return { mode: 'stream', response, cleanup };
}

interface SseEvent {
  event: string;
  data: string;
}

async function consumeSseStream(
  response: Response,
  providerLabel: string,
  maxBytes: number,
  onEvent: (event: SseEvent) => void,
  signal?: AbortSignal | undefined
): Promise<void> {
  const safeMaxBytes = typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes >= 1
    ? Math.floor(maxBytes)
    : MAX_PROVIDER_JSON_BYTES;
  const reader = response.body!.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let totalBytes = 0;
  let currentEvent = '';
  let dataLines: string[] = [];
  let sawFirstLine = false;

  let eventBytes = 0;

  const flushEvent = (): void => {
    if (dataLines.length === 0) {
      currentEvent = '';
      eventBytes = 0;
      return;
    }
    const payload = dataLines.join('\n');
    const eventName = currentEvent || 'message';
    currentEvent = '';
    dataLines = [];
    eventBytes = 0;
    onEvent({ event: eventName, data: payload });
  };

  const processLine = (rawLine: string): void => {
    let stripped = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!sawFirstLine) {
      sawFirstLine = true;
      if (stripped.charCodeAt(0) === 0xfeff) stripped = stripped.slice(1);
    }
    const line = stripped;
    if (line === '') {
      flushEvent();
      return;
    }
    if (line.startsWith(':')) return; // SSE comment / keep-alive
    if (line.startsWith('event:')) {
      const val = line.slice(6);
      currentEvent = (val.startsWith(' ') ? val.slice(1) : val).trim();
      return;
    }
    if (line.startsWith('data:')) {
      const value = line.slice(5);
      const entry = value.startsWith(' ') ? value.slice(1) : value;
      eventBytes += Buffer.byteLength(entry, 'utf8') + 1;
      if (eventBytes > MAX_SSE_BUFFER_BYTES) {
        throw new Error(`${providerLabel} SSE event payload exceeded safety limit (${MAX_SSE_BUFFER_BYTES} bytes).`);
      }
      dataLines.push(entry);
    }
  };

  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > safeMaxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`${providerLabel} stream exceeded maximum allowed size (${safeMaxBytes} bytes).`);
      }

      buffer += decoder.decode(value, { stream: true });
      if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_BUFFER_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(`${providerLabel} SSE event buffer exceeded safety limit (${MAX_SSE_BUFFER_BYTES} bytes).`);
      }

      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        processLine(line);
        newlineIdx = buffer.indexOf('\n');
      }
    }

    buffer += decoder.decode();
    if (buffer.length > 0) {
      for (const tailLine of buffer.split('\n')) {
        processLine(tailLine);
      }
    }
    flushEvent();
  } finally {
    reader.releaseLock();
  }
}

async function consumeNdjsonStream(
  response: Response,
  providerLabel: string,
  maxBytes: number,
  onObject: (obj: Record<string, unknown>) => void,
  signal?: AbortSignal | undefined
): Promise<void> {
  const safeMaxBytes = typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes >= 1
    ? Math.floor(maxBytes)
    : MAX_PROVIDER_JSON_BYTES;
  const reader = response.body!.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let totalBytes = 0;

  const processLine = (rawLine: string): void => {
    const stripped = rawLine.charCodeAt(0) === 0xfeff ? rawLine.slice(1) : rawLine;
    const trimmed = stripped.trim();
    if (!trimmed) return;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) onObject(parsed);
    } catch {
      // Ignore malformed trailing fragments
    }
  };

  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > safeMaxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`${providerLabel} stream exceeded maximum allowed size (${safeMaxBytes} bytes).`);
      }

      buffer += decoder.decode(value, { stream: true });
      if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_BUFFER_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(`${providerLabel} NDJSON line buffer exceeded safety limit (${MAX_SSE_BUFFER_BYTES} bytes).`);
      }

      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        processLine(line);
        newlineIdx = buffer.indexOf('\n');
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      processLine(buffer);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Streams an OpenAI-compatible `/chat/completions` request via SSE and returns
 * a standard OpenAI chat-completion JSON shape (`choices[0].message` + `usage`)
 * so callers reuse the exact same `normalizeOpenAIChatChoiceResponse` pipeline.
 */
export async function streamOpenAICompatibleChat(
  options: Omit<StreamFetchOptions, 'body'> & { payload: Record<string, unknown> }
): Promise<Record<string, unknown>> {
  const streamPayload: Record<string, unknown> = {
    ...options.payload,
    stream: true,
    stream_options: { include_usage: true }
  };

  const opened = await openHardenedStream({
    ...options,
    headers: {
      Accept: 'text/event-stream, application/json',
      ...(options.headers ?? {})
    },
    body: JSON.stringify(streamPayload)
  });

  if (opened.mode === 'json') {
    if (isRecord(opened.data.error)) {
      const msg = redactProviderSecrets(
        typeof opened.data.error.message === 'string' ? opened.data.error.message : JSON.stringify(opened.data.error),
        options.secrets
      );
      throw new Error(`${options.providerLabel} stream error: ${msg}`);
    }
    const choices = Array.isArray(opened.data.choices) ? opened.data.choices : [];
    const first = isRecord(choices[0]) ? choices[0] : null;
    const message = first && isRecord(first.message) ? first.message : null;
    if (message) {
      const reasoning = typeof message.reasoning_content === 'string'
        ? message.reasoning_content
        : (typeof message.reasoning === 'string' ? message.reasoning : '');
      if (reasoning && options.onReasoningChunk) options.onReasoningChunk(reasoning);
      if (typeof message.content === 'string' && message.content && options.onChunk) {
        options.onChunk(message.content);
      }
    }
    return opened.data;
  }

  let content = '';
  let reasoningContent = '';
  let usage: Record<string, unknown> | undefined;
  let finishReason: string | null = null;
  const toolCallMap = new Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>();

  try {
    await consumeSseStream(
      opened.response,
      options.providerLabel,
      options.maxBytes ?? MAX_PROVIDER_JSON_BYTES,
      ({ data }) => {
        const trimmed = data.trim();
        if (!trimmed || trimmed === '[DONE]') return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return;
        }
        if (!isRecord(parsed)) return;

        if (isRecord(parsed.error)) {
          const msg = redactProviderSecrets(
            typeof parsed.error.message === 'string' ? parsed.error.message : JSON.stringify(parsed.error),
            options.secrets
          );
          throw new Error(`${options.providerLabel} stream error: ${msg}`);
        }

        if (isRecord(parsed.usage)) {
          usage = parsed.usage;
        }

        const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
        const first = isRecord(choices[0]) ? choices[0] : null;
        if (!first) return;
        if (typeof first.finish_reason === 'string') finishReason = first.finish_reason;

        const delta = isRecord(first.delta) ? first.delta : null;
        if (!delta) return;

        const rChunk = typeof delta.reasoning_content === 'string'
          ? delta.reasoning_content
          : (typeof delta.reasoning === 'string' ? delta.reasoning : '');
        if (rChunk) {
          reasoningContent += rChunk;
          options.onReasoningChunk?.(rChunk);
        }

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          content += delta.content;
          options.onChunk?.(delta.content);
        } else if (Array.isArray(delta.content)) {
          for (const part of delta.content) {
            if (isRecord(part) && typeof part.text === 'string' && part.text.length > 0) {
              content += part.text;
              options.onChunk?.(part.text);
            }
          }
        }

        if (Array.isArray(delta.tool_calls)) {
          for (let pos = 0; pos < delta.tool_calls.length; pos++) {
            const tc = delta.tool_calls[pos];
            if (!isRecord(tc)) continue;
            let idx: number;
            if (typeof tc.index === 'number' && Number.isInteger(tc.index) && tc.index >= 0) {
              idx = tc.index;
            } else if (typeof tc.id === 'string' && tc.id) {
              const match = [...toolCallMap.entries()].find(([, item]) => item.id === tc.id);
              if (match) {
                idx = match[0];
              } else if (toolCallMap.get(pos)?.id && toolCallMap.get(pos)?.id !== tc.id) {
                idx = Math.max(-1, ...toolCallMap.keys()) + 1;
              } else {
                idx = pos;
              }
            } else {
              idx = pos;
            }
            let entry = toolCallMap.get(idx);
            if (!entry) {
              entry = { id: '', type: 'function', function: { name: '', arguments: '' } };
              toolCallMap.set(idx, entry);
            }
            if (typeof tc.id === 'string' && tc.id) entry.id = tc.id;
            if (isRecord(tc.function)) {
              if (typeof tc.function.name === 'string' && tc.function.name) {
                entry.function.name += tc.function.name;
              }
              if (typeof tc.function.arguments === 'string' && tc.function.arguments) {
                entry.function.arguments += tc.function.arguments;
              }
            }
          }
        }
      },
      options.signal
    );
  } finally {
    opened.cleanup();
  }

  const orderedToolCalls = [...toolCallMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, tc]) => tc);

  const message: Record<string, unknown> = {
    role: 'assistant',
    content
  };
  if (reasoningContent) message.reasoning_content = reasoningContent;
  if (orderedToolCalls.length > 0) message.tool_calls = orderedToolCalls;

  return {
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(usage ? { usage } : {})
  };
}

/**
 * Streams an Anthropic `/v1/messages` request via SSE and reconstructs the
 * canonical Anthropic Messages JSON response (`content` blocks including signed
 * `thinking` blocks, `tool_use` inputs, and full cache-aware `usage`).
 */
export async function streamAnthropicMessages(
  options: Omit<StreamFetchOptions, 'body'> & { payload: Record<string, unknown> }
): Promise<Record<string, unknown>> {
  const streamPayload: Record<string, unknown> = {
    ...options.payload,
    stream: true
  };

  const opened = await openHardenedStream({
    ...options,
    headers: {
      Accept: 'text/event-stream, application/json',
      ...(options.headers ?? {})
    },
    body: JSON.stringify(streamPayload)
  });

  if (opened.mode === 'json') {
    if (opened.data.type === 'error' || isRecord(opened.data.error)) {
      const errObj = isRecord(opened.data.error) ? opened.data.error : opened.data;
      const msg = redactProviderSecrets(
        typeof errObj.message === 'string' ? errObj.message : JSON.stringify(errObj),
        options.secrets
      );
      throw new Error(`${options.providerLabel} stream error: ${msg}`);
    }
    const blocks = Array.isArray(opened.data.content) ? opened.data.content : [];
    for (const block of blocks) {
      if (!isRecord(block)) continue;
      if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
        options.onReasoningChunk?.(block.thinking);
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        options.onChunk?.(block.text);
      }
    }
    return opened.data;
  }

  interface BlockAccumulator {
    block: Record<string, unknown>;
    partialJson: string;
  }
  const blockMap = new Map<number, BlockAccumulator>();
  const usage: Record<string, number> = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0
  };
  let stopReason: string | undefined;
  const applyUsage = (u: Record<string, unknown>): void => {
    if (typeof u.input_tokens === 'number' && Number.isFinite(u.input_tokens) && u.input_tokens >= 0) usage.input_tokens = u.input_tokens;
    if (typeof u.output_tokens === 'number' && Number.isFinite(u.output_tokens) && u.output_tokens >= 0) usage.output_tokens = u.output_tokens;
    if (typeof u.cache_read_input_tokens === 'number' && Number.isFinite(u.cache_read_input_tokens) && u.cache_read_input_tokens >= 0) usage.cache_read_input_tokens = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === 'number' && Number.isFinite(u.cache_creation_input_tokens) && u.cache_creation_input_tokens >= 0) usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
  };

  try {
    await consumeSseStream(
      opened.response,
      options.providerLabel,
      options.maxBytes ?? MAX_PROVIDER_JSON_BYTES,
      ({ data }) => {
        const trimmed = data.trim();
        if (!trimmed) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return;
        }
        if (!isRecord(parsed)) return;

        const eventType = typeof parsed.type === 'string' ? parsed.type : '';

        if (eventType === 'error') {
          const errObj = isRecord(parsed.error) ? parsed.error : parsed;
          const msg = redactProviderSecrets(
            typeof errObj.message === 'string' ? errObj.message : JSON.stringify(errObj),
            options.secrets
          );
          throw new Error(`${options.providerLabel} stream error: ${msg}`);
        }

        if (eventType === 'message_start' && isRecord(parsed.message) && isRecord(parsed.message.usage)) {
          applyUsage(parsed.message.usage);
          return;
        }

        if (eventType === 'message_delta') {
          if (isRecord(parsed.delta) && typeof parsed.delta.stop_reason === 'string') {
            stopReason = parsed.delta.stop_reason;
          }
          if (isRecord(parsed.usage)) {
            applyUsage(parsed.usage);
          }
          return;
        }

        if (eventType === 'content_block_start' && typeof parsed.index === 'number' && Number.isInteger(parsed.index) && parsed.index >= 0 && isRecord(parsed.content_block)) {
          const initial = { ...parsed.content_block };
          if (initial.type === 'text' && typeof initial.text === 'string' && initial.text) {
            options.onChunk?.(initial.text);
          } else if (initial.type === 'thinking' && typeof initial.thinking === 'string' && initial.thinking) {
            options.onReasoningChunk?.(initial.thinking);
          }
          blockMap.set(parsed.index, { block: initial, partialJson: '' });
          return;
        }

        if (eventType === 'content_block_delta' && typeof parsed.index === 'number' && isRecord(parsed.delta)) {
          const acc = blockMap.get(parsed.index);
          if (!acc) return;
          const delta = parsed.delta;
          const deltaType = typeof delta.type === 'string' ? delta.type : '';

          if (deltaType === 'text_delta' && typeof delta.text === 'string') {
            acc.block.text = `${typeof acc.block.text === 'string' ? acc.block.text : ''}${delta.text}`;
            if (delta.text) options.onChunk?.(delta.text);
          } else if (deltaType === 'thinking_delta' && typeof delta.thinking === 'string') {
            acc.block.thinking = `${typeof acc.block.thinking === 'string' ? acc.block.thinking : ''}${delta.thinking}`;
            if (delta.thinking) options.onReasoningChunk?.(delta.thinking);
          } else if (deltaType === 'signature_delta' && typeof delta.signature === 'string') {
            acc.block.signature = `${typeof acc.block.signature === 'string' ? acc.block.signature : ''}${delta.signature}`;
          } else if (deltaType === 'input_json_delta' && typeof delta.partial_json === 'string') {
            acc.partialJson += delta.partial_json;
          }
        }
      },
      options.signal
    );
  } finally {
    opened.cleanup();
  }

  const contentBlocks = [...blockMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, acc]) => {
      if (acc.block.type === 'tool_use' && acc.partialJson.trim().length > 0) {
        const recovered = safeParseJsonObject(acc.partialJson);
        if (Object.keys(recovered).length > 0) {
          acc.block.input = recovered;
        }
      }
      return acc.block;
    });

  return { content: contentBlocks, usage, ...(stopReason ? { stop_reason: stopReason } : {}) };
}

/**
 * Converts a Gemini `:generateContent` endpoint URL to `:streamGenerateContent?alt=sse`
 * while preserving the host, model path, and avoiding any API key in the query string.
 */
export function buildGeminiStreamUrl(generateContentUrl: string): string {
  const parsed = new URL(generateContentUrl);
  parsed.searchParams.delete('key');
  if (parsed.pathname.endsWith(':generateContent')) {
    parsed.pathname = `${parsed.pathname.slice(0, -':generateContent'.length)}:streamGenerateContent`;
  }
  parsed.searchParams.set('alt', 'sse');
  return parsed.toString();
}

/**
 * Streams a Gemini `:streamGenerateContent?alt=sse` response and reconstructs
 * the standard Gemini response (`candidates[0].content.parts`, `usageMetadata`,
 * plus optional accumulated `reasoningContent` from `thought: true` parts).
 */
export async function streamGeminiGenerateContent(
  options: Omit<StreamFetchOptions, 'body'> & { payload: Record<string, unknown> }
): Promise<Record<string, unknown> & { reasoningContent?: string }> {
  const streamUrl = buildGeminiStreamUrl(options.url);
  const opened = await openHardenedStream({
    ...options,
    url: streamUrl,
    headers: {
      Accept: 'text/event-stream, application/json',
      ...(options.headers ?? {})
    },
    body: JSON.stringify(options.payload)
  });

  if (opened.mode === 'json') {
    if (isRecord(opened.data.error)) {
      const msg = redactProviderSecrets(
        typeof opened.data.error.message === 'string' ? opened.data.error.message : JSON.stringify(opened.data.error),
        options.secrets
      );
      throw new Error(`${options.providerLabel} stream error: ${msg}`);
    }
    const candidates = Array.isArray(opened.data.candidates) ? opened.data.candidates : [];
    const first = isRecord(candidates[0]) ? candidates[0] : null;
    const content = first && isRecord(first.content) ? first.content : null;
    const parts = content && Array.isArray(content.parts) ? content.parts : [];
    let reasoning = '';
    for (const part of parts) {
      if (!isRecord(part) || typeof part.text !== 'string' || !part.text) continue;
      if (part.thought === true) {
        reasoning += part.text;
        options.onReasoningChunk?.(part.text);
      } else {
        options.onChunk?.(part.text);
      }
    }
    return reasoning ? { ...opened.data, reasoningContent: reasoning } : opened.data;
  }

  let textContent = '';
  let reasoningContent = '';
  const functionCallParts: Array<Record<string, unknown>> = [];
  let usageMetadata: Record<string, unknown> | undefined;
  let promptFeedback: Record<string, unknown> | undefined;
  let finishReason: string | undefined;
  let sawCandidate = false;

  try {
    await consumeSseStream(
      opened.response,
      options.providerLabel,
      options.maxBytes ?? MAX_PROVIDER_JSON_BYTES,
      ({ data }) => {
        const trimmed = data.trim();
        if (!trimmed || trimmed === '[DONE]') return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return;
        }
        if (!isRecord(parsed)) return;

        if (isRecord(parsed.error)) {
          const msg = redactProviderSecrets(
            typeof parsed.error.message === 'string' ? parsed.error.message : JSON.stringify(parsed.error),
            options.secrets
          );
          throw new Error(`${options.providerLabel} stream error: ${msg}`);
        }

        if (isRecord(parsed.usageMetadata)) {
          usageMetadata = parsed.usageMetadata;
        }
        if (isRecord(parsed.promptFeedback)) {
          promptFeedback = parsed.promptFeedback;
        }

        const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
        const first = isRecord(candidates[0]) ? candidates[0] : null;
        if (!first) return;
        sawCandidate = true;
        if (typeof first.finishReason === 'string') finishReason = first.finishReason;

        const content = isRecord(first.content) ? first.content : null;
        const parts = content && Array.isArray(content.parts) ? content.parts : [];
        for (const part of parts) {
          if (!isRecord(part)) continue;
          if (typeof part.text === 'string' && part.text.length > 0) {
            if (part.thought === true) {
              reasoningContent += part.text;
              options.onReasoningChunk?.(part.text);
            } else {
              textContent += part.text;
              options.onChunk?.(part.text);
            }
          } else if (isRecord(part.functionCall)) {
            const fcPart: Record<string, unknown> = { functionCall: part.functionCall };
            const sig = typeof part.thoughtSignature === 'string' ? part.thoughtSignature : (typeof part.thought_signature === 'string' ? part.thought_signature : undefined);
            if (sig) fcPart.thoughtSignature = sig;
            functionCallParts.push(fcPart);
          }
        }
      },
      options.signal
    );
  } finally {
    opened.cleanup();
  }

  const finalParts: Array<Record<string, unknown>> = [];
  if (textContent) finalParts.push({ text: textContent });
  finalParts.push(...functionCallParts);

  return {
    candidates: sawCandidate ? [{ content: { role: 'model', parts: finalParts }, ...(finishReason ? { finishReason } : {}) }] : [],
    ...(usageMetadata ? { usageMetadata } : {}),
    ...(promptFeedback ? { promptFeedback } : {}),
    ...(reasoningContent ? { reasoningContent } : {})
  };
}

/**
 * Streams an Ollama `/api/chat` request via NDJSON (`stream: true`) and returns
 * the standard Ollama response shape (`message.content`, `message.thinking`,
 * `message.tool_calls`, `prompt_eval_count`, `eval_count`).
 */
export async function streamOllamaChat(
  options: Omit<StreamFetchOptions, 'body'> & { payload: Record<string, unknown> }
): Promise<Record<string, unknown>> {
  const streamPayload: Record<string, unknown> = {
    ...options.payload,
    stream: true
  };

  const opened = await openHardenedStream({
    ...options,
    headers: {
      Accept: 'application/x-ndjson, application/json',
      ...(options.headers ?? {})
    },
    body: JSON.stringify(streamPayload)
  });

  if (opened.mode === 'json') {
    if (typeof opened.data.error === 'string' && opened.data.error) {
      throw new Error(`${options.providerLabel} stream error: ${redactProviderSecrets(opened.data.error, options.secrets)}`);
    }
    if (isRecord(opened.data.error)) {
      const errMsg = typeof opened.data.error.message === 'string' ? opened.data.error.message : JSON.stringify(opened.data.error);
      throw new Error(`${options.providerLabel} stream error: ${redactProviderSecrets(errMsg, options.secrets)}`);
    }
    const msg = isRecord(opened.data.message) ? opened.data.message : null;
    if (msg) {
      if (typeof msg.thinking === 'string' && msg.thinking) options.onReasoningChunk?.(msg.thinking);
      if (typeof msg.content === 'string' && msg.content) options.onChunk?.(msg.content);
    }
    return opened.data;
  }

  let content = '';
  let thinking = '';
  const toolCalls: Array<Record<string, unknown>> = [];
  const toolCallByKey = new Map<string, Record<string, unknown>>();
  let promptEvalCount = 0;
  let evalCount = 0;

  const mergeOllamaToolCall = (rawTc: unknown): void => {
    if (!isRecord(rawTc)) return;
    const fn = isRecord(rawTc.function) ? rawTc.function : null;
    if (!fn) return;
    const rawId = typeof rawTc.id === 'string' && rawTc.id.trim() ? rawTc.id.trim() : '';
    const fnIndex = typeof fn.index === 'number' && Number.isInteger(fn.index) && fn.index >= 0
      ? fn.index
      : (typeof rawTc.index === 'number' && Number.isInteger(rawTc.index) && rawTc.index >= 0 ? rawTc.index : null);
    const key = rawId ? `id:${rawId}` : (fnIndex !== null ? `idx:${fnIndex}` : '');
    if (key && toolCallByKey.has(key)) {
      const target = toolCallByKey.get(key)!;
      const targetFn = isRecord(target.function) ? target.function : {};
      if (typeof fn.name === 'string' && fn.name) {
        if (!targetFn.name) targetFn.name = fn.name;
      }
      if (typeof fn.arguments === 'string') {
        targetFn.arguments = typeof targetFn.arguments === 'string'
          ? (targetFn.arguments === fn.arguments ? targetFn.arguments : `${targetFn.arguments}${fn.arguments}`)
          : fn.arguments;
      } else if (isRecord(fn.arguments)) {
        targetFn.arguments = isRecord(targetFn.arguments)
          ? { ...targetFn.arguments, ...fn.arguments }
          : fn.arguments;
      }
      target.function = targetFn;
      return;
    }
    const serializedSig = (() => {
      try {
        return JSON.stringify({ name: fn.name ?? '', arguments: fn.arguments ?? {} });
      } catch {
        return '';
      }
    })();
    if (serializedSig && toolCalls.some((existing) => {
      const efn = isRecord(existing.function) ? existing.function : null;
      if (!efn) return false;
      try {
        return JSON.stringify({ name: efn.name ?? '', arguments: efn.arguments ?? {} }) === serializedSig;
      } catch {
        return false;
      }
    })) {
      return;
    }
    const entry: Record<string, unknown> = {
      ...rawTc,
      function: { ...fn }
    };
    toolCalls.push(entry);
    if (key) toolCallByKey.set(key, entry);
  };

  try {
    await consumeNdjsonStream(
      opened.response,
      options.providerLabel,
      options.maxBytes ?? MAX_PROVIDER_JSON_BYTES,
      (chunk) => {
        if (typeof chunk.error === 'string' && chunk.error) {
          throw new Error(`${options.providerLabel} stream error: ${redactProviderSecrets(chunk.error, options.secrets)}`);
        }
        if (isRecord(chunk.error)) {
          const errMsg = typeof chunk.error.message === 'string' ? chunk.error.message : JSON.stringify(chunk.error);
          throw new Error(`${options.providerLabel} stream error: ${redactProviderSecrets(errMsg, options.secrets)}`);
        }
        const msg = isRecord(chunk.message) ? chunk.message : null;
        if (msg) {
          if (typeof msg.thinking === 'string' && msg.thinking.length > 0) {
            thinking += msg.thinking;
            options.onReasoningChunk?.(msg.thinking);
          }
          if (typeof msg.content === 'string' && msg.content.length > 0) {
            content += msg.content;
            options.onChunk?.(msg.content);
          }
          if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
            for (const tc of msg.tool_calls) mergeOllamaToolCall(tc);
          }
        }
        if (typeof chunk.prompt_eval_count === 'number' && Number.isFinite(chunk.prompt_eval_count) && chunk.prompt_eval_count >= 0) promptEvalCount = chunk.prompt_eval_count;
        if (typeof chunk.eval_count === 'number' && Number.isFinite(chunk.eval_count) && chunk.eval_count >= 0) evalCount = chunk.eval_count;
      },
      options.signal
    );
  } finally {
    opened.cleanup();
  }

  const message: Record<string, unknown> = { role: 'assistant', content };
  if (thinking) message.thinking = thinking;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    message,
    prompt_eval_count: promptEvalCount,
    eval_count: evalCount
  };
}
