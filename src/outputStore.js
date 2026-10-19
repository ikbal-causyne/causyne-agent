// Sovereign Tool-Output Store
//
// WHY THIS EXISTS
// An oversized tool result used to be truncated to 32k chars and the remainder
// DESTROYED. The only route back to the missing part was to run the tool again:
// a second full execution, plus a second full-size result in the window. The
// decay stub in contextManager.js said so out loud — "Re-run the tool".
//
// Now the complete output is spilled to a file under ~/.causyne/outputs and the
// model is handed the path, so recovery is a bounded fs_read of a line range or
// a code_search_ripgrep over one file. A re-run costs a whole tool execution;
// a targeted read costs a few hundred tokens.
//
// ZERO-MALWARE: pure fs/path/os. No shell, no child process, no dependency, no
// dynamic eval — rules ZM-04/ZM-05 in .agents/rules.json hold by construction.
// Nothing here is obfuscated; it is plain readable code (Vision section 10).

import fs from 'fs';
import path from 'path';
import os from 'os';
import { causyneHome } from './utils/paths.js';

const OUTPUT_DIR = path.join(causyneHome(), 'outputs');

// Matches the audit log's retention thinking: long enough that a spill is still
// there when the model comes back for it later in a long task, short enough
// that the directory cannot grow without bound.
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const FILE_PREFIX = 'tool_';

// How much of the spilled output travels back in the context window. The rest
// stays on disk behind the path.
const PREVIEW_LINES = 40;
const PREVIEW_CHARS = 4000;

/**
 * The spill can be switched off entirely. Set CAUSYNE_OUTPUT_SPILL=0 to fall
 * back to plain truncation.
 */
export function isSpillEnabled() {
  return process.env.CAUSYNE_OUTPUT_SPILL !== '0';
}

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    // Owner-only: tool output routinely contains file contents and command
    // output from the user's machine.
    fs.mkdirSync(OUTPUT_DIR, { recursive: true, mode: 0o700 });
  }
}


function safeFragment(value, fallback) {
  const cleaned = String(value == null ? '' : value).replace(/[^a-zA-Z0-9_-]/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 64) : fallback;
}

function countLines(text) {
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lines++;
  }
  return lines;
}

/**
 * Take the head of `text` without splitting the whole string into an array —
 * these payloads reach tens of megabytes and `split('\n')` on one of those is
 * itself a memory problem.
 */
function headPreview(text) {
  const charLimit = Math.min(text.length, PREVIEW_CHARS);
  let cut = charLimit;
  let seen = 0;
  for (let i = 0; i < charLimit; i++) {
    if (text.charCodeAt(i) === 10) {
      seen++;
      if (seen >= PREVIEW_LINES) { cut = i; break; }
    }
  }
  return text.slice(0, cut);
}

/**
 * Write the full tool output to disk.
 *
 * FAIL-OPEN BY CONTRACT: never throws and never blocks the tool call. A
 * read-only disk or a full volume degrades this feature back to plain
 * truncation, it does not fail the task.
 *
 * @returns {{path: string, bytes: number, lines: number, preview: string}|null}
 */
export function spillToolOutput(text, meta = {}) {
  if (!isSpillEnabled()) return null;
  if (typeof text !== 'string' || text.length === 0) return null;

  try {
    ensureOutputDir();

    const taskId = safeFragment(meta.taskId, 'task');
    const step = safeFragment(meta.step, '0');
    const tool = safeFragment(meta.tool, 'tool');
    const stamp = Date.now().toString(36);
    const file = path.join(OUTPUT_DIR, `${FILE_PREFIX}${taskId}_${step}_${tool}_${stamp}.txt`);

    fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });

    return {
      path: file,
      bytes: Buffer.byteLength(text, 'utf8'),
      lines: countLines(text),
      preview: headPreview(text)
    };
  } catch (e) {
    console.warn(`[output-store] spill skipped: ${e.message}`);
    return null;
  }
}

/**
 * Render a tool result into a document that is actually READABLE by the tools
 * we tell the model to use on it.
 *
 * Spilling `JSON.stringify(result)` was the obvious move and the wrong one: JSON
 * escapes every newline, so a 900 KB result lands as ONE line. `fs_read` with a
 * line range and `code_search_ripgrep` are both line-oriented, so the notice
 * would have been pointing at a file neither of them could work with. Writing
 * the raw field values keeps the line structure the payload actually had.
 */
export function renderSpillDocument(result, meta = {}) {
  if (typeof result === 'string') return result;
  if (result === null || typeof result !== 'object') return String(result);

  const header = [
    '=== CAUSYNE TOOL OUTPUT (full, untruncated) ===',
    `tool : ${meta.tool || 'unknown'}`,
    `task : ${meta.taskId || 'unknown'}   step: ${meta.step == null ? 'unknown' : meta.step}`,
    `saved: ${new Date().toISOString()}`
  ];

  const sections = [];
  const scalars = [];

  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'string' && value.length > 500) {
      // Raw, unescaped — this is the whole point.
      sections.push(`\n--- field: ${key} (${value.length} chars) ---\n${value}`);
    } else if (value !== null && typeof value === 'object') {
      sections.push(`\n--- field: ${key} (JSON) ---\n${JSON.stringify(value, null, 2)}`);
    } else {
      scalars.push(`${key}: ${JSON.stringify(value)}`);
    }
  }

  if (scalars.length > 0) header.push('', ...scalars);
  return header.join('\n') + '\n' + sections.join('\n') + '\n';
}

/**
 * Spill a full tool RESULT (object or string) as a readable document.
 * This is what the agent loop calls; spillToolOutput stays the raw primitive.
 */
export function spillToolResult(result, meta = {}) {
  return spillToolOutput(renderSpillDocument(result, meta), meta);
}

/**
 * The line the model reads in place of the bytes it did not get. It names the
 * exact recovery route, because a notice that only says "truncated" is what
 * drives the model back into a re-run.
 */
export function buildSpillNotice(spill) {
  if (!spill) {
    return '\n\n[... OUTPUT TRUNCATED TO PROTECT THE CONTEXT WINDOW. Narrow your arguments and retry if you need more ...]';
  }
  const kb = (spill.bytes / 1024).toFixed(1);
  return `\n\n[... OUTPUT TRUNCATED HERE (${kb} KB, ${spill.lines} lines total). `
    + `THE COMPLETE OUTPUT IS SAVED AT: ${spill.path} — `
    + `read a line range from that file with fs_read, or search it with code_search_ripgrep. `
    + `DO NOT re-run the tool just to see the rest ...]`;
}

/** The one-line form the decay stub uses once the payload leaves the window. */
export function buildDecayPointer(spill) {
  if (!spill || !spill.path) return '';
  return ` The full output is still on disk at ${spill.path} — read or search that file instead of re-running the tool.`;
}

/**
 * Delete spills past the retention window. Called fire-and-forget when a task
 * starts, so the store self-maintains with no background timer and no installer
 * behaviour (rule ZM-01).
 *
 * @returns {number} files removed
 */
export function pruneOutputStore() {
  try {
    if (!fs.existsSync(OUTPUT_DIR)) return 0;
    const cutoff = Date.now() - RETENTION_MS;
    let removed = 0;

    for (const name of fs.readdirSync(OUTPUT_DIR)) {
      if (!name.startsWith(FILE_PREFIX)) continue;
      const file = path.join(OUTPUT_DIR, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) {
          fs.unlinkSync(file);
          removed++;
        }
      } catch (e) { /* a file that vanished under us needs no pruning */ }
    }
    return removed;
  } catch (e) {
    console.warn(`[output-store] prune skipped: ${e.message}`);
    return 0;
  }
}

/** Absolute path of the store, for the `causyne-agent context` surface. */
export function getOutputDir() {
  return OUTPUT_DIR;
}

/** Current store contents, newest first — used by the CLI reporting surface. */
export function listSpills(limit = 20) {
  try {
    if (!fs.existsSync(OUTPUT_DIR)) return [];
    return fs.readdirSync(OUTPUT_DIR)
      .filter(name => name.startsWith(FILE_PREFIX))
      .map(name => {
        const file = path.join(OUTPUT_DIR, name);
        try {
          const stats = fs.statSync(file);
          return { path: file, bytes: stats.size, modified: stats.mtimeMs };
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.modified - a.modified)
      .slice(0, limit);
  } catch (e) {
    return [];
  }
}
