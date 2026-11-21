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
// dynamic eval — rules ZM-04/ZM-05 hold by construction.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from './utils/paths.js';
function resolveOutputDir() {
    return path.join(causyneHome(), 'outputs');
}
// Matches the audit log's retention thinking: long enough that a spill is still
// there when the model comes back for it later in a long task, short enough
// that the directory cannot grow without bound.
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const FILE_PREFIX = 'tool_';
// How much of the spilled output travels back in the context window. The rest
// stays on disk behind the path.
const PREVIEW_LINES = 40;
const PREVIEW_CHARS = 4000;
const MAX_SPILL_BYTES = 64 * 1024 * 1024;
const MAX_STORE_BYTES = 256 * 1024 * 1024;
/**
 * The spill can be switched off entirely. Set CAUSYNE_OUTPUT_SPILL=0 to fall
 * back to plain truncation.
 */
export function isSpillEnabled() {
    return process.env.CAUSYNE_OUTPUT_SPILL !== '0';
}
function ensureOutputDir() {
    const dir = resolveOutputDir();
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    else {
        const stat = fs.lstatSync(dir);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new Error('Refusing to use symlink or non-directory as output store');
        }
    }
    return dir;
}
function safeFragment(value, fallback) {
    const cleaned = String(value == null ? '' : value).replace(/[^a-zA-Z0-9_-]/g, '');
    return cleaned.length > 0 ? cleaned.slice(0, 64) : fallback;
}
function countLines(text) {
    let lines = 1;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10)
            lines++;
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
            if (seen >= PREVIEW_LINES) {
                cut = i;
                break;
            }
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
 */
export function spillToolOutput(text, meta) {
    if (!isSpillEnabled())
        return null;
    if (typeof text !== 'string' || text.length === 0)
        return null;
    const safeMeta = meta && typeof meta === 'object' ? meta : {};
    try {
        const dir = ensureOutputDir();
        const taskId = safeFragment(safeMeta.taskId, 'task');
        const step = safeFragment(safeMeta.step, '0');
        const tool = safeFragment(safeMeta.tool, 'tool');
        const stamp = `${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
        const file = path.join(dir, `${FILE_PREFIX}${taskId}_${step}_${tool}_${stamp}.txt`);
        let payload = text;
        if (Buffer.byteLength(payload, 'utf8') > MAX_SPILL_BYTES) {
            payload = Buffer.from(payload, 'utf8').subarray(0, MAX_SPILL_BYTES).toString('utf8')
                + '\n[... truncated at 64 MiB spill ceiling ...]';
        }
        fs.writeFileSync(file, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        return {
            path: file,
            bytes: Buffer.byteLength(payload, 'utf8'),
            lines: countLines(payload),
            preview: headPreview(payload)
        };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[output-store] spill skipped: ${msg}`);
        return null;
    }
}
/**
 * Render a tool result into a document that is actually READABLE by the tools
 * we tell the model to use on it.
 */
export function renderSpillDocument(result, meta) {
    if (typeof result === 'string')
        return result;
    if (result === null || typeof result !== 'object')
        return String(result);
    const safeMeta = meta && typeof meta === 'object' ? meta : {};
    const cleanMeta = (val, fallback) => {
        const s = String(val == null ? '' : val).replace(/[\r\n\0]+/g, ' ').trim();
        return s ? s.slice(0, 128) : fallback;
    };
    const header = [
        '=== CAUSYNE TOOL OUTPUT (full, untruncated) ===',
        `tool : ${cleanMeta(safeMeta.tool, 'unknown')}`,
        `task : ${cleanMeta(safeMeta.taskId, 'unknown')}   step: ${safeMeta.step == null ? 'unknown' : cleanMeta(safeMeta.step, 'unknown')}`,
        `saved: ${new Date().toISOString()}`
    ];
    const sections = [];
    const scalars = [];
    const safeJson = (val, pretty) => {
        try {
            return pretty ? JSON.stringify(val, null, 2) : JSON.stringify(val);
        }
        catch {
            return '"[unserializable]"';
        }
    };
    for (const [key, value] of Object.entries(result)) {
        if (typeof value === 'string' && value.length > 500) {
            sections.push(`\n--- field: ${key} (${value.length} chars) ---\n${value}`);
        }
        else if (value !== null && typeof value === 'object') {
            sections.push(`\n--- field: ${key} (JSON) ---\n${safeJson(value, true)}`);
        }
        else {
            scalars.push(`${key}: ${safeJson(value, false)}`);
        }
    }
    if (scalars.length > 0)
        header.push('', ...scalars);
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
    if (!spill || !spill.path)
        return '';
    return ` The full output is still on disk at ${spill.path} — read or search that file instead of re-running the tool.`;
}
/**
 * Delete spills past the retention window. Called fire-and-forget when a task
 * starts, so the store self-maintains with no background timer and no installer
 * behaviour (rule ZM-01).
 */
export function pruneOutputStore() {
    try {
        const dir = resolveOutputDir();
        if (!fs.existsSync(dir))
            return 0;
        const cutoff = Date.now() - RETENTION_MS;
        let removed = 0;
        const dirStat = fs.lstatSync(dir);
        if (dirStat.isSymbolicLink() || !dirStat.isDirectory())
            return 0;
        const survivors = [];
        let totalBytes = 0;
        for (const name of fs.readdirSync(dir)) {
            if (!name.startsWith(FILE_PREFIX))
                continue;
            const file = path.join(dir, name);
            try {
                const stat = fs.lstatSync(file);
                if (stat.isSymbolicLink() || !stat.isFile())
                    continue;
                if (stat.mtimeMs < cutoff) {
                    fs.unlinkSync(file);
                    removed++;
                }
                else {
                    survivors.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
                    totalBytes += stat.size;
                }
            }
            catch {
                // a file that vanished under us needs no pruning
            }
        }
        if (totalBytes > MAX_STORE_BYTES) {
            survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
            for (const item of survivors) {
                if (totalBytes <= MAX_STORE_BYTES)
                    break;
                try {
                    fs.unlinkSync(item.file);
                    totalBytes -= item.size;
                    removed++;
                }
                catch {
                    // ignore race
                }
            }
        }
        return removed;
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[output-store] prune skipped: ${msg}`);
        return 0;
    }
}
/** Absolute path of the store, for the `causyne-agent context` surface. */
export function getOutputDir() {
    return resolveOutputDir();
}
/** Current store contents, newest first — used by the CLI reporting surface. */
export function listSpills(limit = 20) {
    const safeLimit = typeof limit === 'number' && Number.isFinite(limit)
        ? Math.max(1, Math.min(10_000, Math.floor(limit)))
        : 20;
    try {
        const dir = resolveOutputDir();
        if (!fs.existsSync(dir))
            return [];
        const dirStat = fs.lstatSync(dir);
        if (dirStat.isSymbolicLink() || !dirStat.isDirectory())
            return [];
        const results = [];
        for (const name of fs.readdirSync(dir)) {
            if (!name.startsWith(FILE_PREFIX))
                continue;
            const file = path.join(dir, name);
            try {
                const stats = fs.lstatSync(file);
                if (stats.isSymbolicLink() || !stats.isFile())
                    continue;
                results.push({ path: file, bytes: stats.size, modified: stats.mtimeMs });
            }
            catch {
                // skip inaccessible entry
            }
        }
        return results
            .sort((a, b) => b.modified - a.modified)
            .slice(0, safeLimit);
    }
    catch {
        return [];
    }
}
