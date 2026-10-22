// Resolution of `@` mentions for files and directories in user prompts.
//
// Pure Node.js. Zero dependencies. No external shell commands.
//
// Extracts both quoted (`@"path with spaces/file.js"`, `@'path'`) and
// unquoted (`@path/to/file.js`) mentions, resolves them against the active
// working directory and known subprojects, and formats bounded context
// representations so the agent immediately possesses referenced files and
// folder trees without needing exploratory tool calls.
import fs from 'node:fs';
import path from 'node:path';
const MAX_MENTION_FILE_LINES = 500;
const MAX_MENTION_DIR_ITEMS = 40;
/**
 * Extract all @ mentions from prompt text.
 *
 * @param text - User prompt text.
 * @returns Array of parsed mentions.
 */
export function extractMentions(text) {
    if (!text || typeof text !== 'string')
        return [];
    const mentions = [];
    const seen = new Set();
    // 1. Quoted mentions: @"..." or @'...'
    // This allows spaces, e.g. @"pixel2d games/main.js" or @'assets/sprite sheet.png'
    const quotedRegex = /(?:^|\s)@(["'])([^"'\n\r]+)\1/g;
    let match;
    while ((match = quotedRegex.exec(text)) !== null) {
        const raw = match[0].trim();
        const cleanPath = (match[2] ?? '').trim();
        if (cleanPath && !seen.has(cleanPath)) {
            seen.add(cleanPath);
            mentions.push({ raw, path: cleanPath, isQuoted: true });
        }
    }
    // 2. Unquoted mentions: @path/to/file or @dir/
    // Matches @ preceded by start-of-line or whitespace, not part of an email address
    const unquotedRegex = /(?:^|\s)@([a-zA-Z0-9_.\-/\\]+)(?=$|\s|[.,;:?!)\]}])/g;
    while ((match = unquotedRegex.exec(text)) !== null) {
        const raw = match[0].trim();
        const cleanPath = (match[1] ?? '').trim();
        // Skip if already captured via quotes or if empty
        if (!cleanPath || seen.has(cleanPath))
            continue;
        // Do not capture npm scope prefixes on their own or common non-file @ words
        if (cleanPath === 'here' || cleanPath === 'all' || cleanPath === 'workspace') {
            seen.add(cleanPath);
            mentions.push({ raw, path: cleanPath, isQuoted: false, isMeta: true });
            continue;
        }
        seen.add(cleanPath);
        mentions.push({ raw, path: cleanPath, isQuoted: false });
    }
    return mentions;
}
/**
 * Resolve mentioned files and folders against the active working directory
 * and detected subprojects. Returns bounded context blocks for model ingestion.
 *
 * @param prompt - Raw prompt string.
 * @param options - Resolution options.
 * @returns Bounded context and list of mentions.
 */
export async function resolveMentionedContext(prompt, options = {}) {
    const mentions = extractMentions(prompt);
    if (mentions.length === 0) {
        return { mentions: [], referencedContext: '', detectedSubproject: null };
    }
    const cwd = options.cwd || process.cwd();
    const subprojects = Array.isArray(options.subprojects) ? options.subprojects : [];
    const sections = [];
    let detectedSubproject = null;
    for (const m of mentions) {
        if (m.isMeta) {
            if (m.path === 'workspace' || m.path === 'here') {
                sections.push(`📁 REFERENCED SCOPE: Whole workspace (${cwd})`);
            }
            continue;
        }
        let targetPath = path.resolve(cwd, m.path);
        let found = false;
        try {
            if (fs.existsSync(targetPath)) {
                found = true;
            }
        }
        catch {
            // ignore
        }
        // Check if path refers to a file/folder inside any detected subproject
        if (!found && subprojects.length > 0) {
            for (const sp of subprojects) {
                const candidate = path.resolve(cwd, sp, m.path);
                try {
                    if (fs.existsSync(candidate)) {
                        targetPath = candidate;
                        found = true;
                        detectedSubproject = sp;
                        break;
                    }
                }
                catch {
                    // ignore
                }
            }
        }
        // Check if the mention path explicitly names a subproject (e.g. @"pixel2d games/...")
        if (subprojects.length > 0) {
            for (const sp of subprojects) {
                if (m.path === sp || m.path.startsWith(sp + '/') || m.path.startsWith(sp + '\\')) {
                    detectedSubproject = sp;
                    break;
                }
            }
        }
        const relPath = path.relative(cwd, targetPath).split(path.sep).join('/');
        if (!found) {
            sections.push(`📂 REFERENCED PATH: ${m.path} (Note: path was not found on disk at ${relPath})`);
            continue;
        }
        try {
            const stats = fs.statSync(targetPath);
            if (stats.isDirectory()) {
                const entries = fs.readdirSync(targetPath, { withFileTypes: true });
                const summary = entries
                    .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
                    .slice(0, MAX_MENTION_DIR_ITEMS)
                    .map(e => e.isDirectory() ? `${e.name}/` : e.name);
                const more = entries.length > MAX_MENTION_DIR_ITEMS
                    ? `\n  ... (${entries.length - MAX_MENTION_DIR_ITEMS} more items)`
                    : '';
                sections.push(`📁 REFERENCED DIRECTORY: ${relPath}/\n` +
                    `Directory listing (${summary.length} items):\n` +
                    summary.map(s => `  - ${s}`).join('\n') +
                    more);
            }
            else if (stats.isFile()) {
                const content = fs.readFileSync(targetPath, 'utf8');
                const lines = content.split('\n');
                let body;
                if (lines.length > MAX_MENTION_FILE_LINES) {
                    body = lines.slice(0, MAX_MENTION_FILE_LINES).join('\n') +
                        `\n\n... [Truncated: showing first ${MAX_MENTION_FILE_LINES} of ${lines.length} lines. Use fs.read for remaining lines.]`;
                }
                else {
                    body = content;
                }
                sections.push(`📄 REFERENCED FILE: ${relPath} (${lines.length} lines):\n` +
                    '```\n' +
                    body + '\n' +
                    '```');
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            sections.push(`📂 REFERENCED PATH: ${relPath} (Error reading: ${msg})`);
        }
    }
    const referencedContext = sections.length > 0
        ? `\n\n=== REFERENCED WORKSPACE CONTEXT (@ mentions) ===\n` +
            sections.join('\n\n') +
            `\n=== END REFERENCED WORKSPACE CONTEXT ===\n`
        : '';
    return {
        mentions,
        referencedContext,
        detectedSubproject
    };
}
