/**
 * Causyne Agent — Tool Argument Normalization & Pre-Execution Validation (Sector 3)
 *
 * Extracted from `AgentLoop.validateToolArgs` into a standalone Strict TypeScript
 * module so workspace-relative path normalization and required-argument checks
 * are independently testable.
 */
import os from 'node:os';
import path from 'node:path';
const NON_PATH_TARGET_TOOLS = new Set(['vision_inspect_ui', 'astryx_oracle', 'desktop_act']);
function resolveWorkspaceArgPath(raw, baseDir) {
    const val = raw.trim();
    if (!val || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(val)) {
        return null;
    }
    if (val === '~') {
        return os.homedir();
    }
    if (val.startsWith('~/') || val.startsWith('~\\')) {
        return path.join(os.homedir(), val.slice(2));
    }
    if (!path.isAbsolute(val)) {
        return path.resolve(baseDir, val);
    }
    return val;
}
/**
 * Normalizes workspace-relative file path arguments in-place and validates
 * required tool parameters prior to sandbox and hook evaluation.
 * Returns `null` when valid, or an actionable error message when invalid.
 */
export function validateAndNormalizeToolArgs(toolName, args, workspaceRoot = process.cwd()) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return 'Tool arguments must be a JSON object';
    }
    const record = args;
    const baseDir = workspaceRoot || process.cwd();
    // 1. File operations must resolve to absolute paths (fs_read_skill uses skill-relative file_path)
    if (toolName !== 'fs_read_skill') {
        const pathFields = [
            'path', 'searchPath', 'cwd', 'directory',
            'source', 'destination', 'file_path', 'filePath', 'filepath',
            'targetFile', 'outputFile', 'outputPath',
            ...(NON_PATH_TARGET_TOOLS.has(toolName) ? [] : ['target'])
        ];
        for (const field of pathFields) {
            const value = record[field];
            if (typeof value === 'string' && value) {
                const resolved = resolveWorkspaceArgPath(value, baseDir);
                if (resolved !== null) {
                    record[field] = resolved;
                }
            }
        }
        if (Array.isArray(record.target_directories)) {
            record.target_directories = record.target_directories.map((entry) => {
                if (typeof entry !== 'string')
                    return entry;
                return resolveWorkspaceArgPath(entry, baseDir) ?? entry;
            });
        }
    }
    // 2. Terminal commands must have a command string
    if ((toolName === 'sysRun' || toolName === 'sysRunBg') && !record.command) {
        return 'Missing required "command" argument';
    }
    // 3. File write must have a path AND content
    if (toolName === 'fs_write' && !record.path) {
        return 'Missing required "path" argument';
    }
    if (toolName === 'fs_write' && record.content === undefined) {
        return 'Missing required "content" argument';
    }
    // 4. Search must have a query
    if ((toolName === 'codebase_search' || toolName === 'web_search') && !record.query) {
        return 'Missing required "query" argument';
    }
    // 5. Tool search must have a query, pack, or names array
    if (toolName === 'tool_search') {
        const q = typeof record.query === 'string'
            ? record.query.trim()
            : (Array.isArray(record.query) ? record.query.map(String).join(' ').trim() : '');
        const p = typeof record.pack === 'string' ? record.pack.trim() : '';
        const n = Array.isArray(record.names) && record.names.length > 0;
        if (!q && !p && !n) {
            return 'Missing required "query" or "pack" argument';
        }
    }
    // 6. Skill reader must have a non-empty skill_id
    if (toolName === 'fs_read_skill') {
        const sid = typeof record.skill_id === 'string' ? record.skill_id.trim() : '';
        if (!sid) {
            return 'Missing required "skill_id" argument';
        }
    }
    return null;
}
