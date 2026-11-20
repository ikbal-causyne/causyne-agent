/**
 * @file src/tools/payloadSanitizer.ts
 * Causyne Agent — Media Payload Ceilings & Format Sniffer
 *
 * Ported & elevated from OpenClaw (src/media/configured-max-bytes.ts).
 * Enforces strict per-media-kind byte limits (images, audio, video) and
 * validates container magic numbers before staging payloads to LLM APIs,
 * preventing multimodal payloads from overflowing context limits.
 *
 * Authorship: Strict TypeScript (Causyne Agent).
 */
export const DEFAULT_PAYLOAD_LIMITS = {
    maxImageBytes: 5 * 1024 * 1024,
    maxAudioBytes: 10 * 1024 * 1024,
    maxVideoBytes: 25 * 1024 * 1024,
    maxTextChars: 100_000
};
export function detectMagicFormat(buffer) {
    if (buffer.length < 4)
        return null;
    const hex = buffer.toString('hex', 0, 12).toUpperCase();
    // Images
    if (hex.startsWith('FFD8FF'))
        return 'jpeg';
    if (hex.startsWith('89504E47'))
        return 'png';
    if (hex.startsWith('47494638'))
        return 'gif';
    if (hex.startsWith('52494646') && buffer.length >= 12 && buffer.toString('ascii', 8, 12) === 'WEBP')
        return 'webp';
    // Audio
    if (hex.startsWith('52494646') && buffer.length >= 12 && buffer.toString('ascii', 8, 12) === 'WAVE')
        return 'wav';
    if (hex.startsWith('494433') || hex.startsWith('FFFB') || hex.startsWith('FFFA') || hex.startsWith('FFF3') || hex.startsWith('FFF2') || hex.startsWith('FFE3'))
        return 'mp3';
    // Video: valid ISO BMFF box size followed by 'ftyp', 'moov', 'mdat', or 'free'
    if (buffer.length >= 8) {
        const boxSize = buffer.readUInt32BE(0);
        const boxType = buffer.toString('ascii', 4, 8);
        // Reject printable ASCII prefixes (>= 0x20000000) while accepting header-only MP4 slices
        const validBoxSize = boxSize === 0 || boxSize === 1 || (boxSize >= 8 && boxSize < 0x20000000);
        if (validBoxSize && ['ftyp', 'moov', 'mdat', 'free'].includes(boxType))
            return 'mp4';
    }
    return null;
}
export function validateMediaPayload(buffer, kind, limits = {}) {
    const byteLength = buffer.length;
    const safeLimit = (value, fallback) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
    const activeLimits = {
        maxImageBytes: safeLimit(limits.maxImageBytes, DEFAULT_PAYLOAD_LIMITS.maxImageBytes),
        maxAudioBytes: safeLimit(limits.maxAudioBytes, DEFAULT_PAYLOAD_LIMITS.maxAudioBytes),
        maxVideoBytes: safeLimit(limits.maxVideoBytes, DEFAULT_PAYLOAD_LIMITS.maxVideoBytes),
        maxTextChars: safeLimit(limits.maxTextChars, DEFAULT_PAYLOAD_LIMITS.maxTextChars)
    };
    let maxAllowed = activeLimits.maxImageBytes;
    if (kind === 'audio')
        maxAllowed = activeLimits.maxAudioBytes;
    if (kind === 'video')
        maxAllowed = activeLimits.maxVideoBytes;
    if (byteLength > maxAllowed) {
        return {
            valid: false,
            byteLength,
            error: `Payload size (${(byteLength / 1024 / 1024).toFixed(2)} MB) exceeds allowed limit of ${(maxAllowed / 1024 / 1024).toFixed(1)} MB for ${kind}.`
        };
    }
    const format = detectMagicFormat(buffer);
    if (!format) {
        return {
            valid: false,
            byteLength,
            error: `Unrecognized or invalid binary format for ${kind} payload. Magic numbers missing.`
        };
    }
    const expectedKindForFormat = {
        jpeg: 'image', png: 'image', gif: 'image', webp: 'image',
        wav: 'audio', mp3: 'audio',
        mp4: 'video'
    };
    if (expectedKindForFormat[format] !== kind) {
        return {
            valid: false,
            byteLength,
            detectedFormat: format,
            error: `Format mismatch: detected '${format}' which is not a valid ${kind} container.`
        };
    }
    return {
        valid: true,
        byteLength,
        detectedFormat: format
    };
}
export function sanitizeTextPayload(text, maxChars = DEFAULT_PAYLOAD_LIMITS.maxTextChars) {
    const limit = Number.isFinite(maxChars) ? Math.floor(maxChars) : DEFAULT_PAYLOAD_LIMITS.maxTextChars;
    if (limit <= 0)
        return '';
    if (text.length <= limit)
        return text;
    const buildMarker = (count) => `\n[... ${count} characters sanitized to protect context budget ...]\n`;
    let marker = buildMarker(text.length);
    if (limit <= marker.length)
        return text.slice(0, limit);
    let keep = limit - marker.length;
    let headLen = Math.ceil(keep / 2);
    let tailLen = Math.floor(keep / 2);
    let omitted = text.length - headLen - tailLen;
    marker = buildMarker(omitted);
    if (limit <= marker.length)
        return text.slice(0, limit);
    keep = limit - marker.length;
    headLen = Math.ceil(keep / 2);
    tailLen = Math.floor(keep / 2);
    omitted = text.length - headLen - tailLen;
    const finalMarker = buildMarker(omitted);
    if (headLen + finalMarker.length + tailLen > limit) {
        const excess = headLen + finalMarker.length + tailLen - limit;
        tailLen = Math.max(0, tailLen - excess);
        omitted = text.length - headLen - tailLen;
    }
    const tail = tailLen > 0 ? text.slice(-tailLen) : '';
    return text.slice(0, headLen) + buildMarker(omitted) + tail;
}
