/**
 * Causyne Agent — Universal Provider Wire Normalizer
 *
 * Shared pure helpers for all LLM provider adapters so tool definitions,
 * historical tool calls, multimodal blocks, and responses follow one
 * lossless universal contract without duplicating normalization code.
 */

import {
  normalizeToolName,
  decodeFreeFormArguments
} from '../tools/toolScanner.js';
import { repairJsonArguments } from '../tools/toolSelfRepair.js';
import {
  extractToolCallJsonObjects,
  resolveToolCallEnvelopeArguments,
  stripToolCallMarkup
} from '../implementationPlan.js';
import type { ChatResponseToolCall } from './base.js';

export interface NormalizedChoiceResult {
  content: string;
  toolCalls?: ChatResponseToolCall[];
  reasoningContent?: string;
  rawUsage: Record<string, unknown>;
}

const VALID_ID_CHARS = /[^a-zA-Z0-9_-]/g;
let toolIdSequence = 0;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Safely parse tool arguments (JSON string, malformed JSON string, or object) into an object.
 * Never throws on malformed historical messages.
 */
export function safeParseJsonObject(raw: unknown): Record<string, unknown> {
  if (isPlainObject(raw)) return raw;
  if (typeof raw !== 'string') return {};
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '{}') return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (isPlainObject(parsed)) return parsed;
  } catch {
    // Fall through to deterministic syntax recovery
  }
  const repaired = repairJsonArguments(trimmed);
  if (!repaired.error && isPlainObject(repaired.args)) {
    return repaired.args;
  }
  return {};
}

/**
 * Guarantee a valid tool call ID matching ^[a-zA-Z0-9_-]{1,64}$.
 */
export function sanitizeProviderToolId(rawId: unknown, prefix = 'call', index = 0): string {
  const cleaned = typeof rawId === 'string'
    ? rawId.trim().replace(VALID_ID_CHARS, '_')
    : '';
  if (cleaned.length > 0) return cleaned.slice(0, 64);
  const safePrefix = (typeof prefix === 'string' ? prefix.replace(VALID_ID_CHARS, '_') : '') || 'call';
  const safeIndex = typeof index === 'number' && Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
  toolIdSequence = (toolIdSequence + 1) % 100_000;
  return `${safePrefix}_${Date.now()}_${safeIndex}_${toolIdSequence}`.slice(0, 64);
}

function resolveFreeFormPaths(
  toolName: string,
  freeFormPaths?: Map<string, string[][]>
): string[][] | undefined {
  if (!freeFormPaths || freeFormPaths.size === 0) return undefined;
  return freeFormPaths.get(normalizeToolName(toolName)) || freeFormPaths.get(toolName);
}

/**
 * Serialize arguments cleanly to a JSON string while decoding any adapted free-form paths.
 */
function safeCloneObject(obj: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(obj);
  } catch {
    try {
      return JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
    } catch {
      return { ...obj };
    }
  }
}

export function serializeAndDecodeArguments(
  rawArgs: unknown,
  toolName: string,
  freeFormPaths?: Map<string, string[][]>
): string {
  const paths = resolveFreeFormPaths(toolName, freeFormPaths);
  if (typeof rawArgs === 'string') {
    if (rawArgs.trim().length === 0) return '{}';
    if (!paths || paths.length === 0) return rawArgs;
    const obj = safeParseJsonObject(rawArgs);
    if (Object.keys(obj).length === 0) return rawArgs;
    const decoded = decodeFreeFormArguments(safeCloneObject(obj), paths);
    try {
      return JSON.stringify(decoded);
    } catch {
      return rawArgs;
    }
  }
  const obj = isPlainObject(rawArgs) ? safeCloneObject(rawArgs) : {};
  const finalObj = paths && paths.length > 0 ? decodeFreeFormArguments(obj, paths) : obj;
  try {
    return JSON.stringify(finalObj);
  } catch {
    return '{}';
  }
}

/**
 * Extract tool calls embedded as <tool_call>{...}</tool_call> text envelopes.
 */
export function extractTextToolCalls(
  text: string,
  prefix = 'call_text',
  freeFormPaths?: Map<string, string[][]>
): ChatResponseToolCall[] {
  const calls: ChatResponseToolCall[] = [];
  if (!text || typeof text !== 'string') return calls;
  let index = 0;
  const seenIds = new Set<string>();
  for (const parsed of extractToolCallJsonObjects(text)) {
    const fnObj = isPlainObject(parsed['function']) ? parsed['function'] : null;
    const rawName = String(parsed['name'] || parsed['tool'] || fnObj?.['name'] || '').trim();
    if (!rawName) continue;
    const name = normalizeToolName(rawName);
    if (!name) continue;
    const rawArgs = resolveToolCallEnvelopeArguments(parsed);
    let id = sanitizeProviderToolId(parsed['id'], prefix, index);
    if (seenIds.has(id)) id = `${id.slice(0, 56)}_${index}`;
    seenIds.add(id);
    index++;
    calls.push({
      id,
      type: 'function',
      function: {
        name,
        arguments: serializeAndDecodeArguments(rawArgs, name, freeFormPaths)
      }
    });
  }
  return calls;
}

/**
 * Normalize native OpenAI / Ollama / proxy tool_calls into one canonical Causyne contract.
 */
export function normalizeOpenAIToolCalls(
  rawCalls: unknown,
  freeFormPaths?: Map<string, string[][]>,
  prefix = 'call'
): ChatResponseToolCall[] {
  if (!Array.isArray(rawCalls)) return [];
  const normalized: ChatResponseToolCall[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < rawCalls.length; i++) {
    const tc = rawCalls[i];
    if (!isPlainObject(tc)) continue;
    const fnObj = isPlainObject(tc['function']) ? tc['function'] : null;
    const rawName = String(fnObj?.['name'] || tc['name'] || '').trim();
    if (!rawName) continue;
    const name = normalizeToolName(rawName);
    if (!name) continue;
    const rawArgs = fnObj ? fnObj['arguments'] : tc['arguments'];
    let id = sanitizeProviderToolId(tc['id'], prefix, i);
    if (seenIds.has(id)) id = `${id.slice(0, 56)}_${i}`;
    seenIds.add(id);
    normalized.push({
      id,
      type: 'function',
      function: {
        name,
        arguments: serializeAndDecodeArguments(rawArgs ?? {}, name, freeFormPaths)
      }
    });
  }
  return normalized;
}

/**
 * Normalize an OpenAI-compatible (or DeepSeek proxy) JSON response into standard ChatResponse parts,
 * including automatic fallback extraction of XML <tool_call> text envelopes.
 */
export function normalizeOpenAIChatChoiceResponse(
  data: unknown,
  options: {
    prefix?: string;
    freeFormPaths?: Map<string, string[][]>;
    stripToolMarkup?: boolean;
  } = {}
): NormalizedChoiceResult {
  const payload = isPlainObject(data) ? data : {};
  const prefix = options.prefix || 'call';
  let content = '';
  let reasoningContent = '';
  let rawToolCalls: unknown = undefined;

  if (payload['reply'] !== undefined) {
    content = typeof payload['reply'] === 'string' ? payload['reply'] : '';
    rawToolCalls = payload['tool_calls'];
  } else if (Array.isArray(payload['choices']) && payload['choices'].length > 0) {
    const choice = isPlainObject(payload['choices'][0]) ? payload['choices'][0] : null;
    const message = choice && isPlainObject(choice['message']) ? choice['message'] : null;
    if (message) {
      content = typeof message['content'] === 'string' ? message['content'] : '';
      rawToolCalls = message['tool_calls'];
      const rc = message['reasoning_content'] ?? message['reasoning'];
      reasoningContent = typeof rc === 'string' ? rc : '';
    }
  }

  let toolCalls = normalizeOpenAIToolCalls(rawToolCalls, options.freeFormPaths, prefix);
  if (toolCalls.length === 0 && content) {
    const extracted = extractTextToolCalls(content, `${prefix}_text`, options.freeFormPaths);
    if (extracted.length > 0) {
      toolCalls = extracted;
      if (options.stripToolMarkup !== false) {
        content = stripToolCallMarkup(content).trim();
      }
    }
  }

  const rawUsage = isPlainObject(payload['usage'])
    ? payload['usage']
    : { prompt_tokens: 0, completion_tokens: 0 };

  const result: NormalizedChoiceResult = {
    content,
    rawUsage
  };
  if (toolCalls.length > 0) result.toolCalls = toolCalls;
  if (reasoningContent) result.reasoningContent = reasoningContent;
  return result;
}

/**
 * Prepare messages for Anthropic: runs multimodal image/audio normalization and strips internal
 * fields from non-system turns while preserving `cacheAnchor` on `system` turns so Anthropic's
 * cache_control placement remains intact.
 */
export function prepareMessagesForAnthropic(
  provider: {
    supportsVision: boolean;
    supportsAudio: boolean;
    normalizeImageBlocks: (msg: any) => any;
    flattenToTextOnly: (msg: any) => any;
    normalizeAudioBlocks: (msg: any) => any;
    stripAudioBlocks: (msg: any) => any;
    stripInternalFields: (msgs: any[]) => any[];
  },
  messages: unknown[]
): any[] {
  if (!Array.isArray(messages)) return [];
  const prepared: any[] = [];
  for (const msg of messages) {
    if (!isPlainObject(msg)) continue;
    if (msg['role'] === 'system') {
      const { spillPath: _spill, ...rest } = msg;
      prepared.push(rest);
      continue;
    }
    const [cleaned] = provider.stripInternalFields([msg]);
    const visual = provider.supportsVision
      ? provider.normalizeImageBlocks(cleaned)
      : provider.flattenToTextOnly(cleaned);
    const audioReady = provider.supportsAudio
      ? provider.normalizeAudioBlocks(visual)
      : provider.stripAudioBlocks(visual);
    prepared.push(audioReady);
  }
  return prepared;
}

/**
 * Convert OpenAI JSON-string tool_calls arguments into objects for Ollama `/api/chat` history.
 */
export function normalizeMessagesForOllama(messages: unknown[]): any[] {
  if (!Array.isArray(messages)) return [];
  return messages.map((msg) => {
    if (!isPlainObject(msg) || msg['role'] !== 'assistant' || !Array.isArray(msg['tool_calls'])) {
      return msg;
    }
    return {
      ...msg,
      tool_calls: (msg['tool_calls'] as unknown[]).map((tc) => {
        if (!isPlainObject(tc)) return tc;
        const fn = isPlainObject(tc['function']) ? tc['function'] : null;
        if (!fn) return tc;
        return {
          ...tc,
          function: {
            ...fn,
            name: normalizeToolName(String(fn['name'] || '')),
            arguments: safeParseJsonObject(fn['arguments'])
          }
        };
      })
    };
  });
}
