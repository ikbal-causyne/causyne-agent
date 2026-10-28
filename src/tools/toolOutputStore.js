import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { causyneHome } from '../utils/paths.js';
function sanitizeIdentifier(id) {
    const cleaned = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    return cleaned.length > 0 ? cleaned.slice(0, 64) : 'tool';
}
export class ToolOutputStore {
    config;
    constructor(customConfig) {
        this.config = {
            maxChars: customConfig?.maxChars ?? 2500,
            maxLines: customConfig?.maxLines ?? 100,
            maxBytes: customConfig?.maxBytes ?? 50 * 1024,
            headLines: customConfig?.headLines ?? 35,
            tailLines: customConfig?.tailLines ?? 35,
            storageDir: customConfig?.storageDir ?? path.join(causyneHome(), 'tool-output')
        };
    }
    getConfig() {
        return { ...this.config };
    }
    processToolOutput(sessionId, toolCallId, rawOutput) {
        const text = typeof rawOutput === 'string' ? rawOutput : String(rawOutput ?? '');
        const totalBytes = Buffer.byteLength(text, 'utf8');
        const lines = text.split('\n');
        const totalLines = lines.length;
        const contentHash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
        if (process.env.CAUSYNE_OUTPUT_SPILL === '0'
            || (text.length <= this.config.maxChars && totalLines <= this.config.maxLines && totalBytes <= this.config.maxBytes)) {
            return {
                contentForModel: text,
                isTruncated: false,
                totalLines,
                totalBytes,
                contentHash
            };
        }
        const safeSession = sanitizeIdentifier(sessionId);
        const safeToolId = sanitizeIdentifier(toolCallId);
        const sessionDir = path.join(this.config.storageDir, safeSession);
        const diskPath = path.join(sessionDir, `${safeToolId}_${contentHash}.log`);
        let temporaryPath;
        try {
            fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
            if (fs.lstatSync(sessionDir).isSymbolicLink())
                throw new Error('Output directory is a symlink');
            temporaryPath = path.join(sessionDir, `.${crypto.randomUUID()}.tmp`);
            fs.writeFileSync(temporaryPath, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            fs.renameSync(temporaryPath, diskPath);
        }
        catch {
            if (temporaryPath) {
                try {
                    fs.unlinkSync(temporaryPath);
                }
                catch { /* already renamed or unavailable */ }
            }
            // Never discard an observation when its recovery file could not be saved.
            return { contentForModel: text, isTruncated: false, totalLines, totalBytes, contentHash };
        }
        // Line bounds alone do not bound a minified file or a single huge JSON line.
        const omittedLines = Math.max(0, totalLines - (this.config.headLines + this.config.tailLines));
        const notice = [
            `\n[... Causyne ToolOutputStore: ${omittedLines} lines (${Math.max(1, Math.round(totalBytes / 1024))} KB) truncated. Content Hash: ${contentHash} ...]`,
            `[... Full log persisted to: ${diskPath} ...]`,
            '[... Read or search a relevant range with fs_read or code_search_ripgrep; do not rerun the original tool ...]\n'
        ].join('\n');
        let head = '';
        let tail = '';
        if (lines.length === 1) {
            const budget = Math.max(0, this.config.maxChars - notice.length);
            const half = Math.floor(budget / 2);
            head = text.slice(0, half);
            tail = text.slice(-half);
        }
        else {
            const rawHead = lines.slice(0, this.config.headLines).join('\n');
            const rawTail = lines.slice(-this.config.tailLines).join('\n');
            const maxBudget = this.config.maxChars;
            if (rawHead.length + rawTail.length + notice.length > maxBudget) {
                const budget = Math.max(0, maxBudget - notice.length);
                const half = Math.floor(budget / 2);
                head = rawHead.slice(0, half);
                tail = rawTail.slice(-half);
            }
            else {
                head = rawHead;
                tail = rawTail;
            }
        }
        const contentForModel = head + notice + tail;
        return {
            contentForModel,
            isTruncated: true,
            totalLines,
            totalBytes,
            contentHash,
            diskPath
        };
    }
    readSlice(diskPath, startLine, endLine) {
        const resolvedPath = path.resolve(diskPath);
        if (!fs.existsSync(resolvedPath)) {
            throw new Error(`ToolOutputStore: Log file not found at ${resolvedPath}`);
        }
        const relative = path.relative(fs.realpathSync(this.config.storageDir), fs.realpathSync(resolvedPath));
        if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
            throw new Error('ToolOutputStore: Requested file is outside the output store');
        }
        const lines = fs.readFileSync(resolvedPath, 'utf8').split('\n');
        const clampedStart = Math.max(1, Math.min(startLine, lines.length));
        const clampedEnd = Math.max(clampedStart, Math.min(endLine, lines.length));
        return lines.slice(clampedStart - 1, clampedEnd).join('\n');
    }
    pruneOldOutputs(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
        if (!fs.existsSync(this.config.storageDir))
            return 0;
        let pruned = 0;
        const now = Date.now();
        try {
            const sessions = fs.readdirSync(this.config.storageDir);
            for (const session of sessions) {
                const sessionPath = path.join(this.config.storageDir, session);
                const stat = fs.lstatSync(sessionPath);
                if (stat.isDirectory()) {
                    const files = fs.readdirSync(sessionPath);
                    for (const file of files) {
                        const filePath = path.join(sessionPath, file);
                        const fileStat = fs.statSync(filePath);
                        if (now - fileStat.mtimeMs > maxAgeMs) {
                            fs.unlinkSync(filePath);
                            pruned++;
                        }
                    }
                    if (fs.readdirSync(sessionPath).length === 0) {
                        fs.rmdirSync(sessionPath);
                    }
                }
            }
        }
        catch {
            // Non-fatal cleanup
        }
        return pruned;
    }
}
export const defaultToolOutputStore = new ToolOutputStore();
export function processToolOutputWithStore(sessionId, toolCallId, rawOutput, store = defaultToolOutputStore) {
    return store.processToolOutput(sessionId, toolCallId, rawOutput);
}
export function renderSpillDocument(result, meta = {}) {
    if (typeof result === 'string')
        return result;
    if (result === null || typeof result !== 'object')
        return String(result);
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
            sections.push(`\n--- field: ${key} (${value.length} chars) ---\n${value}`);
        }
        else if (value !== null && typeof value === 'object') {
            sections.push(`\n--- field: ${key} (JSON) ---\n${JSON.stringify(value, null, 2)}`);
        }
        else {
            scalars.push(`${key}: ${JSON.stringify(value)}`);
        }
    }
    if (scalars.length > 0)
        header.push('', ...scalars);
    return header.join('\n') + '\n' + sections.join('\n') + '\n';
}
