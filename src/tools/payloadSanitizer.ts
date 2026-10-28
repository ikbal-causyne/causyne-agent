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

export interface PayloadLimits {
  readonly maxImageBytes: number;   // Default: 5 * 1024 * 1024 (5 MB)
  readonly maxAudioBytes: number;   // Default: 10 * 1024 * 1024 (10 MB)
  readonly maxVideoBytes: number;   // Default: 25 * 1024 * 1024 (25 MB)
  readonly maxTextChars: number;    // Default: 100,000 characters
}

export const DEFAULT_PAYLOAD_LIMITS: PayloadLimits = {
  maxImageBytes: 5 * 1024 * 1024,
  maxAudioBytes: 10 * 1024 * 1024,
  maxVideoBytes: 25 * 1024 * 1024,
  maxTextChars: 100_000
};

export interface MediaValidationResult {
  readonly valid: boolean;
  readonly byteLength: number;
  readonly detectedFormat?: string | undefined;
  readonly error?: string | undefined;
}

export function detectMagicFormat(buffer: Buffer): string | null {
  if (buffer.length < 4) return null;
  const hex = buffer.toString('hex', 0, 12).toUpperCase();

  // Images
  if (hex.startsWith('FFD8FF')) return 'jpeg';
  if (hex.startsWith('89504E47')) return 'png';
  if (hex.startsWith('47494638')) return 'gif';
  if (hex.startsWith('52494646') && buffer.length >= 12 && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';

  // Audio
  if (hex.startsWith('52494646') && buffer.length >= 12 && buffer.toString('ascii', 8, 12) === 'WAVE') return 'wav';
  if (hex.startsWith('494433') || hex.startsWith('FFF3') || hex.startsWith('FFF2') || hex.startsWith('FFE3')) return 'mp3';

  // Video: box size followed by 'ftyp' or 'moov'
  if (buffer.length >= 8) {
    const boxType = buffer.toString('ascii', 4, 8);
    if (['ftyp', 'moov', 'mdat', 'free'].includes(boxType)) return 'mp4';
  }

  return null;
}

export function validateMediaPayload(
  buffer: Buffer,
  kind: 'image' | 'audio' | 'video',
  limits: Partial<PayloadLimits> = {}
): MediaValidationResult {
  const byteLength = buffer.length;
  const activeLimits: PayloadLimits = { ...DEFAULT_PAYLOAD_LIMITS, ...limits };

  let maxAllowed = activeLimits.maxImageBytes;
  if (kind === 'audio') maxAllowed = activeLimits.maxAudioBytes;
  if (kind === 'video') maxAllowed = activeLimits.maxVideoBytes;

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

  const expectedKindForFormat: Record<string, 'image' | 'audio' | 'video'> = {
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

export function sanitizeTextPayload(text: string, maxChars: number = DEFAULT_PAYLOAD_LIMITS.maxTextChars): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  const omitted = text.length - maxChars;
  return text.slice(0, half) + `\n[... ${omitted} characters sanitized to protect context budget ...]\n` + text.slice(-half);
}
