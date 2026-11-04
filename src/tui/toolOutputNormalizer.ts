import fs from 'node:fs';

export interface HistoricalToolMessage {
  role?: string | undefined;
  name?: string | undefined;
  tool_call_id?: string | undefined;
  content?: unknown;
  spillPath?: string | undefined;
}

export interface NormalizedHistoricalToolResult {
  skipStep: boolean;
  result: Record<string, unknown>;
  plan?: Array<Record<string, unknown>> | undefined;
}

export interface HistoricalExternalAction {
  id?: string | undefined;
  name?: string | undefined;
  status?: string | undefined;
  detail?: string | undefined;
  parameters?: Record<string, unknown> | undefined;
  error?: string | undefined;
}

export interface NormalizedExternalActionResult {
  toolName: string;
  args: Record<string, unknown>;
  result: {
    success: boolean;
    output: string;
    error?: string | undefined;
  };
}

/**
 * Normalizes an external/native action record for historical transcript restoration,
 * reconstructing arguments and ensuring verified success/failure status.
 */
export function normalizeHistoricalExternalAction(ext: HistoricalExternalAction | null | undefined): NormalizedExternalActionResult {
  const toolName = typeof ext?.name === 'string' && ext.name.trim() ? ext.name.trim() : 'tool';
  const detail = typeof ext?.detail === 'string' ? ext.detail.trim() : '';
  const status = typeof ext?.status === 'string' ? ext.status.toLowerCase().trim() : '';
  const isFailed = status === 'failed' || status === 'error';
  const success = !isFailed;

  const rawParams = ext?.parameters && typeof ext.parameters === 'object' && !Array.isArray(ext.parameters)
    ? { ...ext.parameters }
    : {};
  const lowerTool = toolName.toLowerCase();
  const isFileTool = ['read_file', 'write_file', 'edit_file', 'fs_read', 'fs_write', 'fs_edit', 'view_file'].includes(lowerTool);
  const isCommandTool = ['run_command', 'bash', 'terminal', 'sh', 'zsh', 'sysrun', 'sysrunbg'].includes(lowerTool);

  const args: Record<string, unknown> = {
    ...rawParams,
    ...(detail ? { detail } : {}),
    ...(detail && isFileTool && !rawParams.path && !rawParams.file_path && !rawParams.filePath ? { path: detail } : {}),
    ...(detail && isCommandTool && !rawParams.command && !rawParams.cmd ? { command: detail } : {})
  };

  const result: { success: boolean; output: string; error?: string | undefined } = {
    success,
    output: '',
    ...(isFailed ? { error: typeof ext?.error === 'string' && ext.error ? ext.error : (detail || 'failed') } : {})
  };

  return { toolName, args, result };
}

const DECAY_MARKER = '[decayed]';
const SPILL_HEADER_PREFIX = '=== CAUSYNE TOOL OUTPUT';

/**
 * Strip internal context-compaction markers, ToolOutputStore spill headers,
 * and middle-omission notices so the TUI only displays real tool output.
 */
export function cleanToolOutputPreview(payload: string, toolName = ''): string {
  if (!payload || typeof payload !== 'string') return '';
  if (toolName === 'update_plan') return '';

  const trimmed = payload.trim();
  if (!trimmed || trimmed.startsWith(DECAY_MARKER)) return '';

  let text = payload
    .replace(/\x1b\[(?:[12]K|\d*G)/g, '\n')
    .replace(/(https?:\/\/[^\s"'<>]+?\.[a-z]{2,10})([A-Z][a-z]{2,15}:\s)/g, '$1\n$2');

  // Strip renderSpillDocument metadata header up to the first `--- field: ... ---` marker
  if (text.startsWith(SPILL_HEADER_PREFIX)) {
    const fieldHeaderMatch = /\n--- field: [^\n]+ ---\n/.exec(text);
    if (fieldHeaderMatch && fieldHeaderMatch.index !== undefined) {
      text = text.slice(fieldHeaderMatch.index + fieldHeaderMatch[0].length);
    } else {
      const blankLineIndex = text.indexOf('\n\n');
      if (blankLineIndex !== -1) {
        text = text.slice(blankLineIndex + 2);
      }
    }
  }

  // Strip internal ToolOutputStore and historyPruner middle-omission lines
  const filteredLines = text
    .split('\n')
    .filter(line => {
      const t = line.trim();
      if (t.startsWith('[... Causyne ToolOutputStore:')) return false;
      if (t.startsWith('[... Full log persisted to:')) return false;
      if (t.startsWith('[... Read or search a relevant range')) return false;
      if (/^\[\d+\s+middle characters omitted from active context/i.test(t)) return false;
      return true;
    });

  return filteredLines.join('\n').trim();
}

function readSpillPreview(spillPath: string, maxBytes = 4096): string {
  if (!spillPath || typeof spillPath !== 'string') return '';
  try {
    if (!fs.existsSync(spillPath)) return '';
    const stat = fs.statSync(spillPath);
    if (!stat.isFile() || stat.size <= 0) return '';
    const bytesToRead = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(spillPath, 'r');
    try {
      const buf = Buffer.alloc(bytesToRead);
      const read = fs.readSync(fd, buf, 0, bytesToRead, 0);
      return buf.subarray(0, read).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function extractSpillPathFromDecay(content: string): string | undefined {
  const match = /\bat (\/[^\s]+)\s+—\s+read or search\b/.exec(content);
  return match?.[1];
}

function recoverBrokenJsonOutput(raw: string, spillPath?: string | undefined): Record<string, unknown> | null {
  const prefixMatch = /^\s*\{\s*"success"\s*:\s*(true|false)\b/.exec(raw);
  if (!prefixMatch) return null;
  const success = prefixMatch[1] === 'true';
  if (spillPath) {
    const fromSpill = readSpillPreview(spillPath);
    if (fromSpill) {
      return { success, output: fromSpill, spillPath };
    }
  }
  const outputMatch = /"output"\s*:\s*"([\s\S]*)/.exec(raw);
  if (outputMatch?.[1]) {
    const body = outputMatch[1]
      .replace(/"\s*\}\s*$/, '')
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
    return {
      success,
      output: body,
      ...(spillPath ? { spillPath } : {})
    };
  }
  return {
    success,
    output: '',
    ...(spillPath ? { spillPath } : {})
  };
}

/**
 * Normalize a historical `role: 'tool'` message for TUI session replay.
 * Suppresses internal `checkpoint: 'synthesis'` governor intercepts (which are
 * never emitted during live execution) and recovers clean output previews for
 * `[decayed]` or shortened tool observations.
 */
export function normalizeHistoricalToolResult(
  toolName: string,
  toolMsg: HistoricalToolMessage,
  options: { unpaired?: boolean | undefined } = {}
): NormalizedHistoricalToolResult {
  const explicitSpill = typeof toolMsg.spillPath === 'string' && toolMsg.spillPath.trim()
    ? toolMsg.spillPath.trim()
    : undefined;

  if (typeof toolMsg.content === 'string') {
    const raw = toolMsg.content;
    if (raw.startsWith(DECAY_MARKER)) {
      const spillPath = explicitSpill ?? extractSpillPathFromDecay(raw);
      const isFailure = /^\[decayed\] [^:]+: reported failure\b/i.test(raw);
      const success = !isFailure;
      if (toolName === 'update_plan') {
        return {
          skipStep: Boolean(options.unpaired),
          result: { success: true, output: '' }
        };
      }
      const recoveredRaw = spillPath ? readSpillPreview(spillPath) : '';
      const cleaned = cleanToolOutputPreview(recoveredRaw, toolName);
      return {
        skipStep: false,
        result: {
          success,
          output: cleaned,
          ...(spillPath ? { spillPath } : {})
        }
      };
    }

    let parsed: Record<string, unknown> | null = null;
    try {
      const candidate: unknown = JSON.parse(raw);
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        parsed = { ...(candidate as Record<string, unknown>) };
      }
    } catch {
      parsed = recoverBrokenJsonOutput(raw, explicitSpill);
    }

    if (parsed) {
      if (parsed.checkpoint === 'synthesis') {
        return { skipStep: true, result: parsed };
      }
      if (parsed.success === undefined) {
        parsed.success = !parsed.error;
      }
      if (explicitSpill && typeof parsed.spillPath !== 'string') {
        parsed.spillPath = explicitSpill;
      }
      if (typeof parsed.output === 'string') {
        parsed.output = cleanToolOutputPreview(parsed.output, toolName);
      }
      if (typeof parsed.log === 'string') {
        parsed.log = cleanToolOutputPreview(parsed.log, toolName);
      }
      const plan = Array.isArray(parsed.plan)
        ? (parsed.plan as Array<Record<string, unknown>>)
        : undefined;
      return { skipStep: false, result: parsed, plan };
    }

    const lowered = raw.toLowerCase();
    return {
      skipStep: false,
      result: {
        success: !lowered.startsWith('error') && !lowered.includes('failed'),
        output: cleanToolOutputPreview(raw, toolName),
        ...(explicitSpill ? { spillPath: explicitSpill } : {})
      }
    };
  }

  if (toolMsg.content && typeof toolMsg.content === 'object' && !Array.isArray(toolMsg.content)) {
    const copy: Record<string, unknown> = { ...(toolMsg.content as Record<string, unknown>) };
    if (copy.checkpoint === 'synthesis') {
      return { skipStep: true, result: copy };
    }
    if (copy.success === undefined) copy.success = !copy.error;
    if (explicitSpill && typeof copy.spillPath !== 'string') {
      copy.spillPath = explicitSpill;
    }
    if (typeof copy.output === 'string') {
      copy.output = cleanToolOutputPreview(copy.output, toolName);
    }
    if (typeof copy.log === 'string') {
      copy.log = cleanToolOutputPreview(copy.log, toolName);
    }
    const plan = Array.isArray(copy.plan)
      ? (copy.plan as Array<Record<string, unknown>>)
      : undefined;
    return { skipStep: false, result: copy, plan };
  }

  return {
    skipStep: false,
    result: {
      success: true,
      output: '',
      ...(explicitSpill ? { spillPath: explicitSpill } : {})
    }
  };
}
