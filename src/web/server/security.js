import crypto from 'node:crypto';
export const MAX_JSON_BODY_BYTES = 1024 * 1024;
export const SAFE_SESSION_ID_RE = /^s_[a-zA-Z0-9_-]{3,80}$/;
export const SAFE_PROVIDER_RE = /^[a-zA-Z0-9._/-]{1,64}$/;
export const SAFE_MODEL_RE = /^[a-zA-Z0-9._/:()+ -]{1,128}$/;
const ALLOWED_REMOTE_ORIGINS = new Set(['https://causyne.com', 'https://www.causyne.com']);
export function isAllowedSkybridgeHost(hostHeader, port) {
    if (!hostHeader || typeof hostHeader !== 'string')
        return false;
    const normalized = hostHeader.trim().toLowerCase();
    return normalized === `127.0.0.1:${port}`
        || normalized === `localhost:${port}`
        || normalized === `[::1]:${port}`;
}
export function isAllowedSkybridgeOrigin(originHeader, port, extraOrigins = []) {
    if (!originHeader || typeof originHeader !== 'string')
        return true;
    const trimmed = originHeader.trim();
    if (!trimmed || trimmed === 'null')
        return false;
    let parsed;
    try {
        parsed = new URL(trimmed);
    }
    catch {
        return false;
    }
    const canonical = parsed.origin.toLowerCase();
    if (canonical === `http://127.0.0.1:${port}` || canonical === `http://localhost:${port}`) {
        return true;
    }
    if (ALLOWED_REMOTE_ORIGINS.has(canonical))
        return true;
    for (const extra of extraOrigins) {
        try {
            const parsedExtra = new URL(extra);
            if (parsedExtra.protocol === 'https:' && parsedExtra.origin.toLowerCase() === canonical) {
                return true;
            }
        }
        catch {
            // ignore invalid extra origin
        }
    }
    return false;
}
export function timingSafeBearerMatch(authHeader, expectedToken) {
    if (!authHeader || typeof authHeader !== 'string')
        return false;
    const prefix = 'Bearer ';
    if (!authHeader.startsWith(prefix))
        return false;
    const supplied = authHeader.slice(prefix.length).trim();
    const a = Buffer.from(supplied, 'utf8');
    const b = Buffer.from(expectedToken, 'utf8');
    if (a.length !== b.length || a.length === 0)
        return false;
    return crypto.timingSafeEqual(a, b);
}
export function applySecurityHeaders(res, originHeader, originAllowed) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    if (originHeader && originAllowed) {
        res.setHeader('Access-Control-Allow-Origin', originHeader);
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Vary', 'Origin, Access-Control-Request-Private-Network');
    }
}
export function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(body);
}
export async function readJsonBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > maxBytes) {
            throw new Error('Request body exceeded maximum allowed size.');
        }
        chunks.push(buf);
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (!text)
        return {};
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('JSON request body must be an object.');
    }
    return parsed;
}
