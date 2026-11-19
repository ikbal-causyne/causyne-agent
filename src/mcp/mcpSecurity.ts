/**
 * Causyne Agent — MCP Protocol Security & Untrusted Metadata Bounds
 *
 * Hardens external MCP server integration against:
 * 1. Polynomial / catastrophic ReDoS (CWE-1333) in `tools.include` / `tools.exclude`
 *    glob filters by replacing dynamic `new RegExp()` compilation with a strictly
 *    linear-space iterative wildcard matcher.
 * 2. Context-window flooding & schema bombs (CWE-400) via per-server tool caps,
 *    description/instruction length ceilings, and bounded JSON schema sanitization.
 * 3. Terminal escape injection & Trojan Source hidden Unicode bidi/zero-width
 *    control characters inside untrusted MCP tool names, descriptions, schema
 *    annotations, and server instructions.
 */

import { safeDisplay } from '../tui/text.js';

export const MAX_GLOB_PATTERN_CHARS = 256;
export const MAX_TOOLS_PER_MCP_SERVER = 256;
export const MAX_MCP_TOOL_NAME_CHARS = 128;
export const MAX_MCP_TOOL_DESCRIPTION_CHARS = 2048;
export const MAX_MCP_SERVER_INSTRUCTIONS_CHARS = 4096;
export const MAX_MCP_SCHEMA_STRING_CHARS = 1024;
export const MAX_MCP_SCHEMA_DEPTH = 16;
export const MAX_MCP_SCHEMA_JSON_BYTES = 65_536;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Strips invisible zero-width and Unicode bidirectional override/isolate format
 * characters (Trojan Source vectors: U+202A–U+202E, U+2066–U+2069, U+200B–U+200F,
 * U+061C, U+2060, U+FEFF) in a single linear O(n) pass.
 */
export function stripInvisibleAndBidi(text: string): string {
  if (!text) return '';
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      code === 0x061c ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      code === 0x2060 ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff
    ) {
      continue;
    }
    out += text[i];
  }
  return out;
}

/**
 * ReDoS-free iterative wildcard matcher supporting `*` (0+ code points) and
 * `?` (exactly 1 code point). Uses Unicode code points (`Array.from`) so
 * surrogate pairs match identically to Unicode-mode regexes without constructing
 * any `RegExp`. Guaranteed O(n * m) worst-case time, O(n + m) memory.
 */
export function globMatchesSafe(name: string, pattern: string): boolean {
  if (typeof name !== 'string' || typeof pattern !== 'string') return false;
  if (pattern.length > MAX_GLOB_PATTERN_CHARS) return false;

  const textChars = Array.from(name);
  const rawPatChars = Array.from(pattern);

  // Collapse consecutive `*` wildcards to prevent redundant backtracking steps
  const patChars: string[] = [];
  for (const ch of rawPatChars) {
    if (ch === '*' && patChars[patChars.length - 1] === '*') continue;
    patChars.push(ch);
  }

  let t = 0;
  let p = 0;
  let starIdx = -1;
  let matchIdx = 0;

  while (t < textChars.length) {
    if (p < patChars.length && (patChars[p] === '?' || patChars[p] === textChars[t])) {
      t++;
      p++;
    } else if (p < patChars.length && patChars[p] === '*') {
      starIdx = p;
      matchIdx = t;
      p++;
    } else if (starIdx !== -1) {
      p = starIdx + 1;
      matchIdx++;
      t = matchIdx;
    } else {
      return false;
    }
  }

  while (p < patChars.length && patChars[p] === '*') {
    p++;
  }

  return p === patChars.length;
}

/**
 * Sanitizes untrusted text received from an MCP server (descriptions, server
 * instructions, error strings) via canonical `safeDisplay()`, strips invisible
 * Unicode bidi/zero-width characters, and enforces a strict character cap.
 */
export function sanitizeMcpMetadataText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  const cleaned = stripInvisibleAndBidi(safeDisplay(value)).trim();
  if (cleaned.length <= maxChars) return cleaned;
  const suffix = '… [truncated]';
  const keep = Math.max(0, maxChars - suffix.length);
  return `${cleaned.slice(0, keep).trimEnd()}${suffix}`;
}

/**
 * Validates and sanitizes an MCP tool name. Rejects empty names, names with
 * ASCII control characters / NUL bytes, or names exceeding the length ceiling.
 */
export function sanitizeMcpToolName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const stripped = stripInvisibleAndBidi(value).trim();
  if (stripped.length === 0 || stripped.length > MAX_MCP_TOOL_NAME_CHARS) return null;
  for (let i = 0; i < stripped.length; i++) {
    const code = stripped.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return stripped;
}

function sanitizeSchemaNode(value: unknown, depth: number): unknown {
  if (depth > MAX_MCP_SCHEMA_DEPTH) {
    return { type: 'object', description: 'Nested schema truncated at maximum depth.' };
  }
  if (typeof value === 'string') {
    return sanitizeMcpMetadataText(value, MAX_MCP_SCHEMA_STRING_CHARS);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    const maxItems = 128;
    return value.slice(0, maxItems).map(item => sanitizeSchemaNode(item, depth + 1));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, item] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (count >= 256) break;
      const safeKey = stripInvisibleAndBidi(safeDisplay(key));
      if (!safeKey) continue;
      out[safeKey] = sanitizeSchemaNode(item, depth + 1);
      count++;
    }
    return out;
  }
  return undefined;
}

/**
 * Sanitizes and size-bounds an untrusted MCP tool JSON input schema.
 * Strips ANSI escapes and bidi characters from nested property descriptions,
 * prevents prototype pollution keys, caps nesting depth, and falls back to an
 * empty object schema if serialized size exceeds `MAX_MCP_SCHEMA_JSON_BYTES`.
 */
export function sanitizeMcpInputSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) {
    return { type: 'object', properties: {} };
  }
  const sanitized = sanitizeSchemaNode(schema, 0);
  if (!isRecord(sanitized)) {
    return { type: 'object', properties: {} };
  }
  try {
    const serialized = JSON.stringify(sanitized);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_MCP_SCHEMA_JSON_BYTES) {
      return {
        type: 'object',
        properties: {},
        description: 'MCP tool input schema omitted because it exceeded the 64 KiB safety limit.'
      };
    }
  } catch {
    return { type: 'object', properties: {} };
  }
  return sanitized;
}
