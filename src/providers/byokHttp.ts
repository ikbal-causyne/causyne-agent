// Hardened HTTP transport guard for all BYOK & cloud LLM providers.
// Enforces:
//   - Endpoint URL & protocol validation (blocks cleartext remote API key leakage)
//   - Zero redirect credential exfiltration (`redirect: 'error'`)
//   - Cooperative AbortSignal cancellation + bounded request timeouts
//   - Bounded response & error body streaming (prevents OOM from hostile endpoints)
//   - Secret redaction & ANSI sanitization in error diagnostics
//   - Structured HTTP status & Retry-After metadata preservation
// Authored in Strict TypeScript. Source-available under BUSL-1.1.

import { safeDisplay } from '../tui/text.js';

export const DEFAULT_PROVIDER_TIMEOUT_MS = 180_000;
export const MIN_PROVIDER_TIMEOUT_MS = 1_000;
export const MAX_PROVIDER_TIMEOUT_MS = 600_000;
export const MAX_PROVIDER_JSON_BYTES = 32 * 1024 * 1024;
export const MAX_PROVIDER_ERROR_BYTES = 64 * 1024;
export const MAX_PROVIDER_ERROR_CHARS = 2_048;
export const MAX_SSE_BUFFER_BYTES = 4 * 1024 * 1024;

export interface EndpointValidationOptions {
  hasApiKey?: boolean | undefined;
  allowInsecureHttp?: boolean | undefined;
  providerLabel?: string | undefined;
}

export interface SafeProviderFetchOptions {
  url: string;
  method?: string | undefined;
  headers?: Record<string, string> | undefined;
  body?: RequestInit['body'];
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  providerLabel: string;
  secrets?: ReadonlyArray<string | undefined | null> | undefined;
  allowInsecureHttp?: boolean | undefined;
  hasApiKey?: boolean | undefined;
}

export interface SafeProviderFetchJsonOptions extends SafeProviderFetchOptions {
  maxBytes?: number | undefined;
  maxErrorBytes?: number | undefined;
  onHttpError?: ((context: {
    status: number;
    errorText: string;
    retryAfterMs?: number | undefined;
    response: Response;
  }) => void) | undefined;
}

export class ProviderHttpError extends Error {
  public readonly status: number;
  public readonly retryAfterMs?: number | undefined;
  public readonly code?: string | undefined;

  constructor(
    message: string,
    options: { status: number; retryAfterMs?: number | undefined; code?: string | undefined }
  ) {
    super(message);
    this.name = 'ProviderHttpError';
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.code = options.code;
  }
}

/**
 * Preserve explicit `0` temperature (unlike `options.temperature || 0.1`).
 */
export function resolveTemperature(value: unknown, fallback = 0.1): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Validate that a required cloud BYOK API key is present before issuing a request.
 */
export function requireApiKey(apiKey: unknown, providerLabel: string): string {
  const trimmed = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!trimmed) {
    throw new Error(
      `${providerLabel} API requires a valid API key (BYOK mode). Configure it with \`causyne config\`.`
    );
  }
  if (/[\r\n\0]/.test(trimmed)) {
    throw new Error(`${providerLabel} API key contains invalid control characters.`);
  }
  return trimmed;
}

/**
 * True for loopback addresses where local unencrypted HTTP inference servers
 * (Ollama, LM Studio, vLLM, llama.cpp) legitimately run.
 */
export function isLoopbackHost(rawHostname: string): boolean {
  const host = String(rawHostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  if (host.startsWith('127.')) {
    const octets = host.split('.');
    return octets.length === 4 && octets.every((part) => {
      if (!/^\d{1,3}$/.test(part)) return false;
      const num = Number(part);
      return num >= 0 && num <= 255;
    });
  }
  return false;
}

/**
 * Validate a provider endpoint URL before transmitting requests or credentials.
 * Blocks invalid schemes, embedded URL credentials, and cleartext remote HTTP
 * when transmitting an API key (unless explicitly opted in).
 */
export function validateProviderEndpointUrl(
  rawUrl: string,
  options: EndpointValidationOptions = {}
): string {
  const label = options.providerLabel || 'Provider';
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!trimmed) {
    throw new Error(`${label} endpoint URL is required.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${label} endpoint URL is invalid.`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${label} endpoint URL must use https:// or http:// (got ${parsed.protocol}).`);
  }

  if (parsed.username || parsed.password) {
    throw new Error(`${label} endpoint URL must not embed credentials.`);
  }

  if (
    parsed.protocol === 'http:'
    && options.hasApiKey === true
    && options.allowInsecureHttp !== true
    && !isLoopbackHost(parsed.hostname)
  ) {
    throw new Error(
      `${label} refused to send an API key over unencrypted remote HTTP (${parsed.hostname}). Use https:// or set allowInsecureHttp: true for a trusted private network.`
    );
  }

  return parsed.toString();
}

/**
 * Parse an HTTP `Retry-After` header (delta-seconds or HTTP-date) into bounded ms.
 */
export function parseRetryAfterMs(headerValue: string | null | undefined): number | undefined {
  if (typeof headerValue !== 'string') return undefined;
  const trimmed = headerValue.trim();
  if (!trimmed) return undefined;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return Math.min(seconds * 1000, 300_000);
  }

  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    const delta = parsedDate - Date.now();
    return Math.max(0, Math.min(delta, 300_000));
  }
  return undefined;
}

/**
 * Redact API keys, Bearer tokens, and query keys from provider errors and
 * sanitize terminal control/ANSI escape sequences.
 */
export function redactProviderSecrets(
  rawText: unknown,
  secrets: ReadonlyArray<string | undefined | null> = []
): string {
  let text = safeDisplay(typeof rawText === 'string' ? rawText : String(rawText ?? ''));

  for (const secret of secrets) {
    if (typeof secret === 'string') {
      const trimmed = secret.trim();
      if (trimmed.length >= 6) {
        text = text.split(trimmed).join('[REDACTED]');
        const encoded = encodeURIComponent(trimmed);
        if (encoded !== trimmed && encoded.length >= 6) {
          text = text.split(encoded).join('[REDACTED]');
        }
      }
    }
  }

  // Linear-time token masks (no nested quantifiers / zero ReDoS risk).
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [REDACTED]');
  text = text.replace(/([?&](?:api_?)?key=)[^&\s"']+/gi, '$1[REDACTED]');
  text = text.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,})\b/g, '[REDACTED]');

  if (text.length > MAX_PROVIDER_ERROR_CHARS) {
    return `${text.slice(0, MAX_PROVIDER_ERROR_CHARS)}…`;
  }
  return text;
}

function getHeaderCaseInsensitive(response: Response, name: string): string | null {
  const headers = (response as unknown as { headers?: { get?: (k: string) => string | null } }).headers;
  if (headers && typeof headers.get === 'function') {
    return headers.get(name);
  }
  return null;
}

async function cancelBodySafely(response: Response): Promise<void> {
  try {
    if (response.body && typeof response.body.cancel === 'function') {
      await response.body.cancel();
    }
  } catch {
    // Ignore stream cancellation errors during cleanup.
  }
}

/**
 * Read a Response body as UTF-8 text while enforcing a strict byte cap so a
 * hostile or misconfigured upstream cannot exhaust host RAM.
 */
export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  options: { truncate?: boolean | undefined; label?: string | undefined } = {}
): Promise<string> {
  const limit = Math.max(1, Math.floor(maxBytes));
  const declaredLen = getHeaderCaseInsensitive(response, 'content-length');
  if (!options.truncate && declaredLen && /^\d+$/.test(declaredLen.trim())) {
    const contentLength = Number(declaredLen.trim());
    if (Number.isFinite(contentLength) && contentLength > limit) {
      await cancelBodySafely(response);
      throw new Error(
        `${options.label || 'Provider'} response exceeded maximum allowed size (${limit} bytes).`
      );
    }
  }

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (totalBytes + value.byteLength > limit) {
          if (options.truncate) {
            const remaining = Math.max(0, limit - totalBytes);
            if (remaining > 0) chunks.push(value.subarray(0, remaining));
            await reader.cancel().catch(() => {});
            break;
          }
          await reader.cancel().catch(() => {});
          throw new Error(
            `${options.label || 'Provider'} response exceeded maximum allowed size (${limit} bytes).`
          );
        }
        chunks.push(value);
        totalBytes += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  if (typeof response.text === 'function') {
    const text = await response.text();
    const byteLen = Buffer.byteLength(text, 'utf8');
    if (byteLen > limit) {
      if (options.truncate) return text.slice(0, limit);
      throw new Error(
        `${options.label || 'Provider'} response exceeded maximum allowed size (${limit} bytes).`
      );
    }
    return text;
  }

  return '';
}

function clampTimeout(timeoutMs: unknown): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
    return DEFAULT_PROVIDER_TIMEOUT_MS;
  }
  return Math.max(MIN_PROVIDER_TIMEOUT_MS, Math.min(Math.floor(timeoutMs), MAX_PROVIDER_TIMEOUT_MS));
}

function isAbortLikeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * Perform a hardened `fetch()` to an LLM provider endpoint with:
 * - Endpoint URL validation
 * - `redirect: 'error'` (prevents auth header leakage across redirects)
 * - Cooperative caller AbortSignal + bounded request timeout
 * - Secret redaction on thrown network errors
 */
export async function safeProviderFetch(
  options: SafeProviderFetchOptions
): Promise<{ response: Response; cleanup: () => void }> {
  const hasKey = options.hasApiKey ?? Object.entries(options.headers ?? {}).some(
    ([k, v]) => /^(?:authorization|x-api-key|x-goog-api-key)$/i.test(k) && Boolean(v)
  );

  const safeUrl = validateProviderEndpointUrl(options.url, {
    hasApiKey: hasKey,
    allowInsecureHttp: options.allowInsecureHttp,
    providerLabel: options.providerLabel
  });

  const timeoutMs = clampTimeout(options.timeoutMs);
  const controller = new AbortController();
  let timedOut = false;

  const onCallerAbort = (): void => {
    controller.abort(options.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
  };

  if (options.signal) {
    if (options.signal.aborted) {
      onCallerAbort();
    } else {
      options.signal.addEventListener('abort', onCallerAbort, { once: true });
    }
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException(`Timed out after ${timeoutMs}ms`, 'TimeoutError'));
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  const cleanup = (): void => {
    clearTimeout(timer);
    if (options.signal) {
      options.signal.removeEventListener('abort', onCallerAbort);
    }
  };

  const fetchInit: RequestInit = {
    method: options.method || 'POST',
    redirect: 'error',
    signal: controller.signal
  };
  if (options.headers) fetchInit.headers = options.headers;
  if (options.body !== undefined) fetchInit.body = options.body;

  try {
    const response = await fetch(safeUrl, fetchInit);
    return { response, cleanup };
  } catch (err: unknown) {
    cleanup();
    if (options.signal?.aborted) {
      throw err;
    }
    if (timedOut || (isAbortLikeError(err) && !options.signal?.aborted)) {
      const timeoutErr = new Error(
        `${options.providerLabel} request timed out after ${timeoutMs}ms (ETIMEDOUT)`
      ) as Error & { code?: string };
      timeoutErr.code = 'ETIMEDOUT';
      throw timeoutErr;
    }
    const rawMsg = err instanceof Error ? err.message : String(err);
    const causeMsg = err instanceof Error && err.cause instanceof Error ? err.cause.message : '';
    const combined = `${rawMsg} ${causeMsg}`.toLowerCase();
    if (combined.includes('redirect')) {
      throw new Error(
        `${options.providerLabel} refused an HTTP redirect to protect API credentials.`
      );
    }
    const safeMsg = redactProviderSecrets(rawMsg, options.secrets);
    throw new Error(`${options.providerLabel} network error: ${safeMsg}`);
  }
}

/**
 * Perform a hardened BYOK provider JSON request, enforcing bounded response/error
 * reading, secret redaction, Retry-After extraction, and clean non-JSON error handling.
 */
export async function safeProviderFetchJson<T = Record<string, unknown>>(
  options: SafeProviderFetchJsonOptions
): Promise<T> {
  const { response, cleanup } = await safeProviderFetch(options);
  try {
    if (!response.ok) {
      const rawError = await readBoundedResponseText(
        response,
        options.maxErrorBytes ?? MAX_PROVIDER_ERROR_BYTES,
        { truncate: true, label: options.providerLabel }
      ).catch(() => '');
      const cleanError = redactProviderSecrets(rawError, options.secrets);
      const retryAfterMs = parseRetryAfterMs(getHeaderCaseInsensitive(response, 'retry-after'));

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
    }

    // Minimal unit-test mocks may supply `.json()` without `.body` or `.text()`.
    if (!response.body && typeof response.text !== 'function' && typeof response.json === 'function') {
      return (await response.json()) as T;
    }

    const rawText = await readBoundedResponseText(
      response,
      options.maxBytes ?? MAX_PROVIDER_JSON_BYTES,
      { truncate: false, label: options.providerLabel }
    );

    try {
      return JSON.parse(rawText) as T;
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
