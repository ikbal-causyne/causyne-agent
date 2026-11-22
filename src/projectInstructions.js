/**
 * Causyne Agent — Hierarchical Project Instructions Loader (Phase C-Core)
 *
 * Discovers and merges repository instruction files in deterministic precedence:
 *   1. User global `~/.causyne/CAUSYNE.md` (if present)
 *   2. Repository/workspace root down to active subdirectory:
 *      `CAUSYNE.md`, `AGENTS.md`, `CLAUDE.md`
 *   3. Scoped rule files under `.causyne/rules/*.md` (lexicographical order)
 *
 * Security invariants:
 *   - Refuses symlinks and non-regular files (`lstatSync`).
 *   - Enforces strict per-file (`16 KiB`) and total (`32 KiB`) character budgets.
 *   - Redacts accidental provider secrets and sanitizes terminal control escapes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from './utils/paths.js';
import { redactProviderSecrets } from './providers/byokHttp.js';
import { safeDisplay } from './tui/text.js';
import { resolveGitRepoRoot } from './worktreeManager.js';
const MAX_SINGLE_INSTRUCTION_CHARS = 16_384;
const MAX_TOTAL_INSTRUCTION_CHARS = 32_768;
const MAX_RULE_FILES = 24;
const INSTRUCTION_FILENAMES = ['CAUSYNE.md', 'AGENTS.md', 'CLAUDE.md'];
function readSafeInstructionFile(filePath, remainingBudget) {
    try {
        const stat = fs.lstatSync(filePath);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0)
            return null;
        const cap = Math.min(MAX_SINGLE_INSTRUCTION_CHARS, remainingBudget);
        if (cap <= 0)
            return null;
        const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
        const redacted = redactProviderSecrets(raw).trim();
        if (!redacted)
            return null;
        const truncated = redacted.length > cap;
        const content = truncated ? `${redacted.slice(0, cap)}\n...[truncated]` : redacted;
        return { content, bytes: stat.size, truncated };
    }
    catch {
        return null;
    }
}
function directoryChain(topDir, leafDir) {
    const resolvedTop = path.resolve(topDir);
    const resolvedLeaf = path.resolve(leafDir);
    const rel = path.relative(resolvedTop, resolvedLeaf);
    if (rel.startsWith('..') || path.isAbsolute(rel))
        return [resolvedLeaf];
    const chain = [resolvedTop];
    if (!rel)
        return chain;
    let cursor = resolvedTop;
    for (const segment of rel.split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, segment);
        chain.push(cursor);
    }
    return chain;
}
function nativeRealpath(targetPath) {
    try {
        return typeof fs.realpathSync.native === 'function'
            ? fs.realpathSync.native(targetPath)
            : fs.realpathSync(targetPath);
    }
    catch {
        return path.resolve(targetPath);
    }
}
export function loadProjectInstructions(workspaceDir = process.cwd(), env = process.env) {
    const resolvedWs = nativeRealpath(workspaceDir);
    const repoRoot = resolveGitRepoRoot(resolvedWs);
    const entries = [];
    const seenPaths = new Set();
    let totalChars = 0;
    let anyTruncated = false;
    const tryAdd = (candidatePath, scope) => {
        const resolved = path.resolve(candidatePath);
        if (seenPaths.has(resolved))
            return;
        seenPaths.add(resolved);
        const remaining = MAX_TOTAL_INSTRUCTION_CHARS - totalChars;
        if (remaining <= 0) {
            anyTruncated = true;
            return;
        }
        const read = readSafeInstructionFile(resolved, remaining);
        if (!read)
            return;
        totalChars += read.content.length;
        if (read.truncated)
            anyTruncated = true;
        entries.push({
            sourcePath: resolved,
            scope,
            bytes: read.bytes,
            truncated: read.truncated,
            content: read.content
        });
    };
    // 1. User global instructions
    const homeDir = env.CAUSYNE_HOME && String(env.CAUSYNE_HOME).trim()
        ? path.resolve(String(env.CAUSYNE_HOME).trim())
        : causyneHome();
    tryAdd(path.join(homeDir, 'CAUSYNE.md'), 'global');
    // 2. Hierarchical repo root -> active workspace directory
    const dirs = repoRoot ? directoryChain(repoRoot, resolvedWs) : [resolvedWs];
    for (const dir of dirs) {
        for (const filename of INSTRUCTION_FILENAMES) {
            tryAdd(path.join(dir, filename), 'workspace');
        }
        // 3. Scoped `.causyne/rules/*.md` files
        const rulesDir = path.join(dir, '.causyne', 'rules');
        try {
            const stat = fs.lstatSync(rulesDir);
            if (!stat.isSymbolicLink() && stat.isDirectory()) {
                const ruleFiles = fs.readdirSync(rulesDir)
                    .filter((name) => name.toLowerCase().endsWith('.md') && !name.startsWith('.'))
                    .sort()
                    .slice(0, MAX_RULE_FILES);
                for (const ruleFile of ruleFiles) {
                    tryAdd(path.join(rulesDir, ruleFile), 'rule');
                }
            }
        }
        catch { /* directory absent */ }
    }
    return {
        workspaceRoot: resolvedWs,
        repoRoot,
        entries,
        totalChars,
        truncated: anyTruncated
    };
}
export function formatProjectInstructionsPrompt(loaded) {
    if (!loaded || loaded.entries.length === 0)
        return '';
    const blocks = loaded.entries.map((entry) => {
        const rel = path.relative(loaded.workspaceRoot, entry.sourcePath);
        const label = entry.scope === 'global'
            ? `~/.causyne/${path.basename(entry.sourcePath)}`
            : (rel && !rel.startsWith('..') ? rel : entry.sourcePath);
        return `## Project Rules (${entry.scope}: ${safeDisplay(label)})\n${entry.content}`;
    });
    return `\n\n# WORKSPACE PROJECT INSTRUCTIONS (loaded deterministically from repository rules — safety boundaries and sandbox rules still take precedence)\n\n${blocks.join('\n\n')}`;
}
export function formatProjectRulesReport(workspaceDir = process.cwd(), env = process.env) {
    const loaded = loadProjectInstructions(workspaceDir, env);
    if (loaded.entries.length === 0) {
        return [
            'Project Instructions & Rules',
            '  Status : none loaded',
            `  Lookup : CAUSYNE.md, AGENTS.md, CLAUDE.md, .causyne/rules/*.md`,
            '  Tip    : Run /init or create CAUSYNE.md in your repository root.'
        ].join('\n');
    }
    const lines = [
        `Project Instructions & Rules (${loaded.entries.length} file(s), ${loaded.totalChars} chars${loaded.truncated ? ', budget-truncated' : ''})`,
        ''
    ];
    for (const entry of loaded.entries) {
        lines.push(`  • [${entry.scope}] ${safeDisplay(entry.sourcePath)} (${entry.bytes} bytes${entry.truncated ? ', truncated' : ''})`);
    }
    return lines.join('\n');
}
