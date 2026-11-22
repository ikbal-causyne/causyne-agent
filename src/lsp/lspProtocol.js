/**
 * Causyne Agent — LSP JSON-RPC 2.0 Content-Length Wire Framing (Phase B1)
 *
 * Pure Buffer-based framing encoder/decoder for Language Server Protocol stdio
 * streams. Handles arbitrary chunk boundaries, multi-byte UTF-8 payloads,
 * strict frame size ceilings, and prototype-pollution key stripping.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export const MAX_LSP_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
const HEADER_SEPARATOR = Buffer.from('\r\n\r\n', 'ascii');
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function stripForbiddenKeys(value, depth = 0) {
    if (depth > 32 || value === null || typeof value !== 'object')
        return value;
    if (Array.isArray(value)) {
        return value.map((item) => stripForbiddenKeys(item, depth + 1));
    }
    const out = Object.create(null);
    for (const [key, val] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.has(key))
            continue;
        out[key] = stripForbiddenKeys(val, depth + 1);
    }
    return Object.assign({}, out);
}
export function encodeLspMessage(payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    if (body.length > MAX_LSP_FRAME_BYTES) {
        throw new RangeError(`LSP message exceeds maximum frame size (${MAX_LSP_FRAME_BYTES} bytes).`);
    }
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
    return Buffer.concat([header, body]);
}
function parseContentLength(headerText) {
    const lines = headerText.split('\r\n');
    for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon <= 0)
            continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        if (name !== 'content-length')
            continue;
        const rawValue = line.slice(colon + 1).trim();
        if (!/^\d{1,10}$/.test(rawValue))
            return null;
        const parsed = Number.parseInt(rawValue, 10);
        if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_LSP_FRAME_BYTES) {
            return null;
        }
        return parsed;
    }
    return null;
}
export class LspMessageParser {
    buffer = Buffer.alloc(0);
    reset() {
        this.buffer = Buffer.alloc(0);
    }
    feed(chunk) {
        const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (piece.length === 0)
            return [];
        this.buffer = this.buffer.length === 0 ? piece : Buffer.concat([this.buffer, piece]);
        const messages = [];
        while (this.buffer.length > 0) {
            const sepIdx = this.buffer.indexOf(HEADER_SEPARATOR);
            if (sepIdx === -1) {
                if (this.buffer.length > MAX_HEADER_BYTES) {
                    this.reset();
                    throw new Error('LSP header exceeded maximum allowed size without terminator.');
                }
                break;
            }
            if (sepIdx > MAX_HEADER_BYTES) {
                this.reset();
                throw new Error('LSP header block exceeded maximum allowed size.');
            }
            const headerText = this.buffer.subarray(0, sepIdx).toString('ascii');
            const contentLength = parseContentLength(headerText);
            if (contentLength === null) {
                this.reset();
                throw new Error('LSP frame missing valid Content-Length header.');
            }
            const bodyStart = sepIdx + HEADER_SEPARATOR.length;
            const frameEnd = bodyStart + contentLength;
            if (this.buffer.length < frameEnd) {
                break;
            }
            const bodyText = this.buffer.subarray(bodyStart, frameEnd).toString('utf8');
            this.buffer = this.buffer.subarray(frameEnd);
            try {
                const parsed = JSON.parse(bodyText);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    messages.push(stripForbiddenKeys(parsed));
                }
            }
            catch {
                // Skip malformed JSON body while keeping stream framing synchronized
            }
        }
        return messages;
    }
}
export function filePathToUri(filePath) {
    return pathToFileURL(path.resolve(filePath)).href;
}
export function uriToFilePath(uri) {
    if (typeof uri !== 'string' || !uri.trim())
        return '';
    if (uri.startsWith('file://')) {
        try {
            return fileURLToPath(uri);
        }
        catch {
            return uri;
        }
    }
    return uri;
}
