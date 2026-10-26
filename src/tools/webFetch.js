import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BrowserCapabilityError, causyneBrowser } from '../browser/causyneBrowser.js';
import { assertPublicWebUrl } from '../browser/urlPolicy.js';
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 80_000;
const REQUEST_TIMEOUT_MS = 30_000;
function decodeEntities(text) {
    const named = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (full, entity) => {
        if (entity.startsWith('#x'))
            return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
        if (entity.startsWith('#'))
            return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
        return named[entity.toLowerCase()] ?? full;
    });
}
export function htmlToReadableText(html) {
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
function isWithin(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function validatedHeaders(value) {
    if (value === undefined)
        return {};
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('headers must be an object');
    const result = {};
    for (const [key, item] of Object.entries(value)) {
        if (typeof item !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n]/.test(item)) {
            throw new Error('headers contain an invalid name or value');
        }
        result[key] = item;
    }
    return result;
}
async function fetchFollowingSafeRedirects(urlValue, options) {
    let url = await assertPublicWebUrl(urlValue);
    let request = { ...options };
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
        const response = await fetch(url, { ...request, redirect: 'manual' });
        if (![301, 302, 303, 307, 308].includes(response.status))
            return { response, finalUrl: url };
        if (redirect === MAX_REDIRECTS)
            throw new Error(`Too many redirects (maximum ${MAX_REDIRECTS})`);
        const location = response.headers.get('location');
        if (!location)
            throw new Error(`HTTP ${response.status} redirect has no Location header`);
        await response.body?.cancel().catch(() => { });
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
async function readBoundedBody(response) {
    if (!response.body)
        return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            size += value.byteLength;
            if (size > MAX_RESPONSE_BYTES) {
                await reader.cancel(`Response exceeds ${MAX_RESPONSE_BYTES} bytes`).catch(() => { });
                throw new Error(`Response exceeds ${MAX_RESPONSE_BYTES} bytes`);
            }
            chunks.push(value);
        }
    }
    finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), size);
}
async function browserFallback(url, workspace) {
    try {
        const results = await causyneBrowser(workspace ? { workspace } : undefined).run([{ type: 'goto', url }, { type: 'extract', selector: 'body' }], workspace ? { workspace } : undefined);
        const output = results.find(result => result.action === 'extract')?.output;
        return output ? { success: true, output } : { success: false, error: 'Browser loaded the page but extracted no readable content' };
    }
    catch (error) {
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
    async execute(args, sandbox) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            if (!args.url)
                return { success: false, error: 'url is required' };
            const workspace = path.resolve(sandbox?.workspacePaths?.[0] ?? sandbox?.workspaceRoot ?? process.cwd());
            const method = (args.method ?? 'GET').toUpperCase();
            const headers = {
                'User-Agent': 'Causyne-Agent/1.10 (+https://causyne.com)',
                Accept: 'text/html,application/xhtml+xml,application/json,text/plain,*/*;q=0.8',
                ...validatedHeaders(args.headers)
            };
            const request = { method, headers, signal: controller.signal };
            if (args.body !== undefined && method !== 'GET' && method !== 'HEAD')
                request.body = args.body;
            const { response, finalUrl } = await fetchFollowingSafeRedirects(args.url, request);
            const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
            if (!response.ok && !args.outputFile && contentType.includes('text/html') && [401, 403, 429, 503].includes(response.status)) {
                const fallback = await browserFallback(finalUrl.href, workspace);
                if (fallback.success)
                    return { ...fallback, status: response.status, finalUrl: finalUrl.href, via: 'causyne-browser' };
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
            if (!response.ok)
                return { success: false, error: `HTTP ${response.status} ${response.statusText}`.trim(), status: response.status, finalUrl: finalUrl.href };
            const declaredLength = Number(response.headers.get('content-length') ?? '0');
            if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
                return { success: false, error: `Response exceeds ${MAX_RESPONSE_BYTES} bytes` };
            }
            const bytes = await readBoundedBody(response);
            if (args.outputFile) {
                const target = path.resolve(workspace, args.outputFile);
                if (!isWithin(workspace, target))
                    return { success: false, error: 'Download target must stay inside the selected workspace' };
                const temporary = `${target}.part-${crypto.randomUUID()}`;
                await fs.mkdir(path.dirname(target), { recursive: true });
                try {
                    await fs.writeFile(temporary, bytes, { mode: 0o600 });
                    await fs.rename(temporary, target);
                }
                finally {
                    await fs.unlink(temporary).catch(() => { });
                }
                return { success: true, output: `Downloaded ${bytes.length} bytes to ${target}`, status: response.status, finalUrl: finalUrl.href };
            }
            const decoded = bytes.toString('utf8');
            const readable = contentType.includes('text/html') ? htmlToReadableText(decoded) : decoded;
            const output = readable.length > MAX_OUTPUT_CHARS
                ? `${readable.slice(0, MAX_OUTPUT_CHARS)}\n\n[Web output truncated at ${MAX_OUTPUT_CHARS} characters]`
                : readable;
            return { success: true, output, status: response.status, finalUrl: finalUrl.href, contentType };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const timedOut = error instanceof Error && (error.name === 'AbortError' || message === 'This operation was aborted');
            return { success: false, error: timedOut ? `Request timed out after ${REQUEST_TIMEOUT_MS}ms` : message };
        }
        finally {
            clearTimeout(timer);
        }
    }
};
