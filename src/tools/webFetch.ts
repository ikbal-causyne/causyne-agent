import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { BrowserCapabilityError, causyneBrowser } from '../browser/causyneBrowser.js';
import { assertPublicWebUrl } from '../browser/urlPolicy.js';

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 80_000;
const REQUEST_TIMEOUT_MS = 30_000;

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (full, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return named[entity.toLowerCase()] ?? full;
  });
}

export function htmlToReadableText(html: string): string {
  return decodeEntities(String(html ?? ''))
    .replace(/<(script|style|svg|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|article|section|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function validatedHeaders(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('headers must be an object');
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n]/.test(item)) {
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
    if (redirect === MAX_REDIRECTS) throw new Error(`Too many redirects (maximum ${MAX_REDIRECTS})`);
    const location = response.headers.get('location');
    if (!location) throw new Error(`HTTP ${response.status} redirect has no Location header`);
    await response.body?.cancel().catch(() => {});
    url = await assertPublicWebUrl(new URL(location, url).href);
    if (response.status === 303 || ([301, 302].includes(response.status) && request.method === 'POST')) {
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

async function browserFallback(url: string): Promise<{ success: boolean; output?: string; error?: string; requiresConsent?: boolean }> {
  try {
    const results = await causyneBrowser().run([{ type: 'goto', url }, { type: 'extract', selector: 'body' }]);
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

  async execute(args: { url?: string; method?: string; headers?: unknown; body?: string; outputFile?: string }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      if (!args.url) return { success: false, error: 'url is required' };
      const method = (args.method ?? 'GET').toUpperCase();
      const headers = {
        'User-Agent': 'Causyne-Agent/1.10 (+https://causyne.com)',
        Accept: 'text/html,application/xhtml+xml,application/json,text/plain,*/*;q=0.8',
        ...validatedHeaders(args.headers)
      };
      const request: RequestInit = { method, headers, signal: controller.signal };
      if (args.body !== undefined && method !== 'GET' && method !== 'HEAD') request.body = args.body;
      const { response, finalUrl } = await fetchFollowingSafeRedirects(args.url, request);
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';

      if (!response.ok && !args.outputFile && contentType.includes('text/html') && [401, 403, 429, 503].includes(response.status)) {
        const fallback = await browserFallback(finalUrl.href);
        if (fallback.success) return { ...fallback, status: response.status, finalUrl: finalUrl.href, via: 'causyne-browser' };
        return { success: false, error: `HTTP ${response.status}; browser fallback failed: ${fallback.error}`, requiresConsent: fallback.requiresConsent };
      }
      if (!response.ok) return { success: false, error: `HTTP ${response.status} ${response.statusText}`.trim(), status: response.status, finalUrl: finalUrl.href };

      const declaredLength = Number(response.headers.get('content-length') ?? '0');
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        return { success: false, error: `Response exceeds ${MAX_RESPONSE_BYTES} bytes` };
      }
      const bytes = await readBoundedBody(response);

      if (args.outputFile) {
        const workspace = path.resolve(process.cwd());
        const target = path.resolve(workspace, args.outputFile);
        if (!isWithin(workspace, target)) return { success: false, error: 'Download target must stay inside the selected workspace' };
        const temporary = `${target}.part-${crypto.randomUUID()}`;
        await fs.mkdir(path.dirname(target), { recursive: true });
        try {
          await fs.writeFile(temporary, bytes, { mode: 0o600 });
          await fs.rename(temporary, target);
        } finally {
          await fs.unlink(temporary).catch(() => {});
        }
        return { success: true, output: `Downloaded ${bytes.length} bytes to ${target}`, status: response.status, finalUrl: finalUrl.href };
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
