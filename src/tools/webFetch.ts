import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { BrowserCapabilityError, causyneBrowser } from '../browser/causyneBrowser.js';
import { assertPublicWebUrl } from '../browser/urlPolicy.js';
import { ensureSafeWorkspaceOutputPath } from '../browser/workspacePathSafety.js';

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 80_000;
const REQUEST_TIMEOUT_MS = 30_000;

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (full, entity: string) => {
    const normalized = entity.toLowerCase();
    const codePoint = normalized.startsWith('#x') ? Number.parseInt(normalized.slice(2), 16)
      : normalized.startsWith('#') ? Number.parseInt(normalized.slice(1), 10) : null;
    if (codePoint !== null) {
      return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff &&
        !(codePoint >= 0xd800 && codePoint <= 0xdfff) ? String.fromCodePoint(codePoint) : full;
    }
    return Object.hasOwn(named, normalized) ? named[normalized]! : full;
  });
}

const SKIP_CONTENT_TAGS = new Set(['script', 'style', 'svg', 'noscript']);
const BLOCK_CLOSE_TAGS = new Set(['p', 'div', 'article', 'section', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr']);

export function htmlToReadableText(html: string): string {
  const src = String(html ?? '');
  const parts: string[] = [];
  let skipTag: string | null = null;
  let i = 0;

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      if (!skipTag) parts.push(src.slice(i));
      break;
    }
    if (!skipTag && lt > i) {
      parts.push(src.slice(i, lt));
    }

    // HTML comments: <!-- ... -->
    if (src.startsWith('<!--', lt)) {
      const commentEnd = src.indexOf('-->', lt + 4);
      i = commentEnd === -1 ? src.length : commentEnd + 3;
      if (!skipTag) parts.push(' ');
      continue;
    }

    let gt = lt + 1;
    let quote: string | null = null;
    while (gt < src.length) {
      const ch = src[gt]!;
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      gt++;
    }
    if (gt >= src.length) {
      // Unclosed '<': emit remaining literal text if not inside a skipped element
      if (!skipTag) parts.push(src.slice(lt));
      break;
    }

    const rawTag = src.slice(lt + 1, gt).trim();
    const isClosing = rawTag.startsWith('/');
    const isSelfClosing = !isClosing && rawTag.endsWith('/');
    let nameStart = isClosing ? 1 : 0;
    while (nameStart < rawTag.length && (rawTag[nameStart] === ' ' || rawTag[nameStart] === '\t' || rawTag[nameStart] === '\n' || rawTag[nameStart] === '\r')) {
      nameStart++;
    }
    let nameEnd = nameStart;
    while (nameEnd < rawTag.length) {
      const code = rawTag.charCodeAt(nameEnd);
      const isAlphaNum = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
      if (!isAlphaNum) break;
      nameEnd++;
    }
    const tagName = rawTag.slice(nameStart, nameEnd).toLowerCase();

    if (skipTag) {
      if (isClosing && tagName === skipTag) {
        skipTag = null;
        parts.push(' ');
      }
    } else if (!isClosing && !isSelfClosing && SKIP_CONTENT_TAGS.has(tagName)) {
      skipTag = tagName;
      parts.push(' ');
    } else if (tagName === 'br' || (isClosing && BLOCK_CLOSE_TAGS.has(tagName))) {
      parts.push('\n');
    } else {
      parts.push(' ');
    }

    i = gt + 1;
  }

  return decodeEntities(parts.join(''))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function isBinaryResponseContentType(contentType: string): boolean {
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (mediaType === 'image/svg+xml' || mediaType.startsWith('text/')) return false;
  if (/^application\/(?:json|xml|javascript|ecmascript|x-javascript|x-www-form-urlencoded|graphql|sql|yaml|x-yaml|x-ndjson)$/.test(mediaType)) return false;
  if (/^application\/.+\+(?:json|xml)$/.test(mediaType)) return false;
  return /^(?:application|image|audio|video|font)\//.test(mediaType);
}

export function looksLikeBinaryContent(bytes: Buffer): boolean {
  if (bytes.length === 0) return false;
  const magic = bytes.subarray(0, 8).toString('hex');
  return /^(?:89504e470d0a1a0a|504b0304|504b0506|25504446|1f8b|ffd8ff|0061736d)/i.test(magic)
    || bytes.subarray(0, 512).includes(0);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

const FORBIDDEN_REQUEST_HEADERS = new Set(['host', 'connection', 'proxy-connection', 'proxy-authorization', 'content-length', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'keep-alive']);

function validatedHeaders(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('headers must be an object');
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n]/.test(item) || FORBIDDEN_REQUEST_HEADERS.has(key.toLowerCase())) {
      throw new Error('headers contain an invalid name or value');
    }
    result[key] = item;
  }
  return result;
}

async function fetchFollowingSafeRedirects(urlValue: string, options: RequestInit): Promise<{ response: Response; finalUrl: URL }> {
  let url = await assertPublicWebUrl(urlValue);
  let request = { ...options };
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    const response = await fetch(url, { ...request, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, finalUrl: url };
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (redirect === MAX_REDIRECTS) throw new Error(`Too many redirects (maximum ${MAX_REDIRECTS})`);
    if (!location) throw new Error(`HTTP ${response.status} redirect has no Location header`);
    const nextUrl = await assertPublicWebUrl(new URL(location, url).href);
    if (url.protocol === 'https:' && nextUrl.protocol !== 'https:') {
      throw new Error('HTTPS to HTTP redirect downgrade is not allowed');
    }
    if (nextUrl.origin !== url.origin && request.method !== 'GET' && request.method !== 'HEAD') {
      throw new Error('Cross-origin redirect blocked for state-changing HTTP request');
    }
    if (nextUrl.origin !== url.origin) {
      const forwardedHeaders = new Headers();
      const currentHeaders = new Headers(request.headers);
      for (const name of ['accept', 'accept-language', 'user-agent']) {
        const value = currentHeaders.get(name);
        if (value !== null) forwardedHeaders.set(name, value);
      }
      request = { ...request, headers: forwardedHeaders };
    }
    url = nextUrl;
    if ((response.status === 303 && request.method !== 'HEAD') || ([301, 302].includes(response.status) && request.method === 'POST')) {
      const redirectedHeaders = new Headers(request.headers);
      redirectedHeaders.delete('content-length');
      redirectedHeaders.delete('content-type');
      const { body: _discardedBody, ...redirectedRequest } = request;
      request = { ...redirectedRequest, method: 'GET', headers: redirectedHeaders };
    }
  }
  throw new Error('Redirect handling failed');
}

async function readBoundedBody(response: Response): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel(`Response exceeds ${MAX_RESPONSE_BYTES} bytes`).catch(() => {});
        throw new Error(`Response exceeds ${MAX_RESPONSE_BYTES} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), size);
}

export async function writeResponseBodyAtomically(
  response: Response, workspace: string, target: string, maxBytes = MAX_RESPONSE_BYTES
): Promise<number> {
  await ensureSafeWorkspaceOutputPath(workspace, target);
  const temporary = `${target}.part-${crypto.randomUUID()}`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  const reader = response.body?.getReader();
  let received = 0;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        if (received + value.byteLength > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes`);
        let offset = 0;
        while (offset < value.byteLength) {
          const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset, null);
          if (bytesWritten <= 0) throw new Error('Download made no write progress');
          offset += bytesWritten;
        }
        received += value.byteLength;
      }
    }
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, target);
    return received;
  } catch (error) {
    await reader?.cancel().catch(() => {});
    throw error;
  } finally {
    reader?.releaseLock();
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

async function browserFallback(url: string, workspace?: string): Promise<{ success: boolean; output?: string; error?: string; requiresConsent?: boolean }> {
  try {
    const results = await causyneBrowser(workspace ? { workspace } : undefined).run(
      [{ type: 'goto', url }, { type: 'extract', selector: 'body' }],
      workspace ? { workspace } : undefined
    );
    const output = results.find(result => result.action === 'extract')?.output;
    return output ? { success: true, output } : { success: false, error: 'Browser loaded the page but extracted no readable content' };
  } catch (error) {
    if (error instanceof BrowserCapabilityError) {
      return { success: false, error: error.message, requiresConsent: error.requiresConsent };
    }
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export const webFetch = {
  schema: {
    name: 'web.fetch',
    description: 'Fetch a public HTTP(S) resource with redirect-by-redirect SSRF checks, bounded output, browser fallback for blocked HTML, and atomic workspace-scoped downloads.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        method: { type: 'string', enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        body: { type: 'string' },
        outputFile: { type: 'string', description: 'File destination inside the selected workspace.' }
      },
      required: ['url'],
      additionalProperties: false
    }
  },

  async execute(
    args: { url?: string; method?: string; headers?: unknown; body?: string; outputFile?: string },
    sandbox?: { workspacePaths?: string[]; workspaceRoot?: string }
  ) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      if (!args.url) return { success: false, error: 'url is required' };
      const workspace = path.resolve(sandbox?.workspacePaths?.[0] ?? sandbox?.workspaceRoot ?? process.cwd());
      if (args.method !== undefined && typeof args.method !== 'string') {
        return { success: false, error: 'HTTP method must be a string' };
      }
      const method = (args.method ?? 'GET').toUpperCase();
      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        return { success: false, error: 'Unsupported HTTP method' };
      }
      if (args.outputFile !== undefined && (typeof args.outputFile !== 'string' || !args.outputFile.trim())) {
        return { success: false, error: 'Download outputFile must be a non-empty string' };
      }
      if (method === 'HEAD' && args.outputFile) {
        return { success: false, error: 'HEAD responses cannot be downloaded as resource files' };
      }
      const headers = {
        'User-Agent': 'Causyne-Agent/1.10 (+https://causyne.com)',
        Accept: 'text/html,application/xhtml+xml,application/json,text/plain,*/*;q=0.8',
        ...validatedHeaders(args.headers)
      };
      const request: RequestInit = { method, headers, signal: controller.signal };
      if (args.body !== undefined) {
        if (typeof args.body !== 'string') return { success: false, error: 'HTTP request body must be a string' };
        if (method === 'GET' || method === 'HEAD') return { success: false, error: `${method} requests cannot contain a body` };
        request.body = args.body;
      }
      const { response, finalUrl } = await fetchFollowingSafeRedirects(args.url, request);
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';

      if (response.status === 401) {
        await response.body?.cancel().catch(() => {});
        return {
          success: false, status: 401, finalUrl: finalUrl.href,
          failureKind: 'authentication_required', error: 'HTTP 401: this resource requires authentication'
        };
      }
      if (response.status === 503 && response.headers.has('retry-after')) {
        const retryAfter = response.headers.get('retry-after');
        await response.body?.cancel().catch(() => {});
        return { success: false, status: 503, finalUrl: finalUrl.href, failureKind: 'service_unavailable',
          ...(retryAfter ? { retryAfter } : {}),
          error: 'HTTP 503: respect the Retry-After window before requesting this resource again' };
      }
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        await response.body?.cancel().catch(() => {});
        return {
          success: false, status: 429, finalUrl: finalUrl.href, failureKind: 'rate_limited',
          ...(retryAfter ? { retryAfter } : {}),
          error: 'HTTP 429 rate limit: respect the Retry-After window before retrying'
        };
      }
      if (args.outputFile && response.status === 206 && !(new Headers(headers)).has('range')) {
        await response.body?.cancel().catch(() => {});
        return { success: false, status: 206, finalUrl: finalUrl.href, error: 'Server returned partial content without a requested Range' };
      }
      if (args.outputFile && response.status === 204) {
        await response.body?.cancel().catch(() => {});
        return { success: false, status: 204, finalUrl: finalUrl.href, error: 'No downloadable content was returned (HTTP 204)' };
      }
      if (!response.ok && method === 'GET' && !args.outputFile && contentType.includes('text/html') && [401, 403, 429, 503].includes(response.status)) {
        await response.body?.cancel().catch(() => {});
        const fallback = await browserFallback(finalUrl.href, workspace);
        if (fallback.success) return { ...fallback, status: response.status, finalUrl: finalUrl.href, via: 'causyne-browser' };
        const nextStep = response.status === 403
          ? 'Try another public source or a supported browser capability.'
          : response.status === 401
            ? 'This resource requires authentication.'
            : response.status === 429
              ? 'Respect the site retry window before requesting it again.'
              : 'The site may be temporarily unavailable; verify its status before retrying.';
        return {
          success: false,
          status: response.status,
          finalUrl: finalUrl.href,
          failureKind: response.status === 403 ? 'site_refusal' : response.status === 429 ? 'rate_limited' : 'http_error',
          error: `HTTP ${response.status} from ${finalUrl.hostname}; browser fallback unavailable: ${fallback.error}. ${nextStep}`,
          requiresConsent: fallback.requiresConsent
        };
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return { success: false, error: `HTTP ${response.status} ${response.statusText}`.trim(), status: response.status, finalUrl: finalUrl.href };
      }

      if (!args.outputFile && isBinaryResponseContentType(contentType)) {
        await response.body?.cancel().catch(() => {});
        return { success: false, error: 'Binary content requires outputFile to download without corrupting bytes', status: response.status, finalUrl: finalUrl.href, contentType };
      }
      const declaredLength = Number(response.headers.get('content-length') ?? '0');
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => {});
        return { success: false, error: `Response exceeds ${MAX_RESPONSE_BYTES} bytes` };
      }
      if (args.outputFile) {
        const target = path.resolve(workspace, args.outputFile);
        if (!isWithin(workspace, target)) {
          await response.body?.cancel().catch(() => {});
          return { success: false, error: 'Download target must stay inside the selected workspace' };
        }
        const received = await writeResponseBodyAtomically(response, workspace, target);
        const partial = response.status === 206;
        return { success: true, output: `Downloaded ${partial ? 'partial content: ' : ''}${received} bytes to ${target}`,
          status: response.status, finalUrl: finalUrl.href, ...(partial ? { partial: true } : {}) };
      }
      const bytes = await readBoundedBody(response);
      if (looksLikeBinaryContent(bytes)) {
        return { success: false, error: 'Binary content requires outputFile to download without corrupting bytes',
          status: response.status, finalUrl: finalUrl.href, contentType };
      }

      const decoded = bytes.toString('utf8');
      const readable = contentType.includes('text/html') ? htmlToReadableText(decoded) : decoded;
      const output = readable.length > MAX_OUTPUT_CHARS
        ? `${readable.slice(0, MAX_OUTPUT_CHARS)}\n\n[Web output truncated at ${MAX_OUTPUT_CHARS} characters]`
        : readable;
      return { success: true, output, status: response.status, finalUrl: finalUrl.href, contentType };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = error instanceof Error && (error.name === 'AbortError' || message === 'This operation was aborted');
      return { success: false, error: timedOut ? `Request timed out after ${REQUEST_TIMEOUT_MS}ms` : message };
    } finally {
      clearTimeout(timer);
    }
  }
};
