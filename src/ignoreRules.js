/**
 * Causyne Agent — Centralized `.causyneignore` & `.gitignore` Policy Engine
 *
 * Enforces workspace-configured file exclusions across reads, searches, repo
 * maps, and checkpoints using strictly linear, ReDoS-free segment matching.
 * Supports comments (`#`), directory rules (`dir/`), anchored paths (`/foo`),
 * wildcard globs (`*.key`, `dist/**`), and negation (`!keep.env`) with
 * standard last-match-wins semantics.
 */
import fs from 'node:fs';
import path from 'node:path';
const MAX_IGNORE_FILE_BYTES = 128 * 1024;
const MAX_IGNORE_RULES = 512;
const matcherCache = new Map();
export function clearIgnoreRulesCache() {
    matcherCache.clear();
}
function matchWildcardSegment(text, pattern) {
    if (pattern === '*' || pattern === text)
        return true;
    if (!pattern.includes('*') && !pattern.includes('?'))
        return text === pattern;
    // Linear two-pointer wildcard matcher (* and ?) — guaranteed O(N + M), zero ReDoS
    let ti = 0;
    let pi = 0;
    let starIdx = -1;
    let matchIdx = 0;
    while (ti < text.length) {
        if (pi < pattern.length && (pattern[pi] === '?' || pattern[pi] === text[ti])) {
            ti++;
            pi++;
        }
        else if (pi < pattern.length && pattern[pi] === '*') {
            starIdx = pi;
            matchIdx = ti;
            pi++;
        }
        else if (starIdx !== -1) {
            pi = starIdx + 1;
            matchIdx++;
            ti = matchIdx;
        }
        else {
            return false;
        }
    }
    while (pi < pattern.length && pattern[pi] === '*')
        pi++;
    return pi === pattern.length;
}
function matchSegments(pathSegs, ruleSegs) {
    // Iterative DP over small segment counts (bounded <= 32 segments)
    const n = pathSegs.length;
    const m = ruleSegs.length;
    let prev = new Uint8Array(m + 1);
    prev[0] = 1;
    for (let j = 1; j <= m; j++) {
        if (ruleSegs[j - 1] === '**')
            prev[j] = prev[j - 1];
    }
    for (let i = 1; i <= n; i++) {
        const curr = new Uint8Array(m + 1);
        for (let j = 1; j <= m; j++) {
            const rSeg = ruleSegs[j - 1];
            if (rSeg === '**') {
                curr[j] = (curr[j - 1] || prev[j]) ? 1 : 0;
            }
            else if (prev[j - 1] && matchWildcardSegment(pathSegs[i - 1], rSeg)) {
                curr[j] = 1;
            }
        }
        prev = curr;
    }
    return prev[m] === 1;
}
export function parseIgnoreContent(rawText) {
    const rules = [];
    const lines = String(rawText || '').split(/\r?\n/);
    for (const rawLine of lines) {
        if (rules.length >= MAX_IGNORE_RULES)
            break;
        let line = rawLine.trim();
        if (!line || line.startsWith('#'))
            continue;
        let negated = false;
        if (line.startsWith('!')) {
            negated = true;
            line = line.slice(1).trim();
        }
        if (!line)
            continue;
        const dirOnly = line.endsWith('/');
        if (dirOnly)
            line = line.replace(/\/+$/, '');
        const anchored = line.startsWith('/');
        if (anchored)
            line = line.replace(/^\/+/, '');
        const normalized = line.replace(/\\/g, '/');
        if (!normalized || normalized.includes('\0'))
            continue;
        const segments = normalized.split('/').filter(Boolean);
        if (segments.length === 0 || segments.length > 32)
            continue;
        rules.push({
            pattern: normalized,
            segments,
            negated,
            dirOnly,
            anchored
        });
    }
    return rules;
}
function ruleMatchesRelPath(rule, relPosix, isDir) {
    const pathSegs = relPosix.split('/').filter(Boolean);
    if (pathSegs.length === 0)
        return false;
    if (rule.dirOnly) {
        // Matches the directory itself OR any descendant inside that directory
        const maxLen = isDir ? pathSegs.length : pathSegs.length - 1;
        for (let prefixLen = 1; prefixLen <= maxLen; prefixLen++) {
            const prefixSegs = pathSegs.slice(0, prefixLen);
            if (rule.anchored || rule.segments.length > 1) {
                if (matchSegments(prefixSegs, rule.segments))
                    return true;
            }
            else if (matchWildcardSegment(prefixSegs[prefixLen - 1], rule.segments[0])) {
                return true;
            }
        }
        return false;
    }
    if (rule.anchored || rule.segments.length > 1) {
        if (matchSegments(pathSegs, rule.segments))
            return true;
        // Also match descendants if a directory rule omitted trailing slash (e.g. "secrets" or "build/out")
        for (let prefixLen = 1; prefixLen < pathSegs.length; prefixLen++) {
            if (matchSegments(pathSegs.slice(0, prefixLen), rule.segments))
                return true;
        }
        return false;
    }
    // Unanchored single-segment pattern matches basename OR any ancestor directory segment
    const targetSeg = rule.segments[0];
    for (const seg of pathSegs) {
        if (matchWildcardSegment(seg, targetSeg))
            return true;
    }
    return false;
}
function canonicalizeIgnorePath(rawPath) {
    const resolved = path.resolve(rawPath);
    try {
        return typeof fs.realpathSync.native === 'function'
            ? fs.realpathSync.native(resolved)
            : fs.realpathSync(resolved);
    }
    catch {
        return resolved;
    }
}
function relativeIgnorePosix(rootPath, targetPath) {
    let root = rootPath;
    let target = targetPath;
    if (process.platform === 'win32') {
        root = root.replace(/^\\\\\?\\/, '');
        target = target.replace(/^\\\\\?\\/, '');
        const rootLower = root.toLowerCase();
        const targetLower = target.toLowerCase();
        const relLower = path.relative(rootLower, targetLower).replace(/\\/g, '/');
        if (!relLower || relLower === '.' || relLower === '..' || relLower.startsWith('../') || /^[a-z]:/i.test(relLower)) {
            return null;
        }
        // Preserve original casing from target suffix while computing containment case-insensitively
        return target.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/') || relLower;
    }
    const rel = path.relative(root, target).replace(/\\/g, '/');
    if (!rel || rel === '.' || rel === '..' || rel.startsWith('../'))
        return null;
    return rel;
}
export function createIgnoreMatcher(workspaceRoot, rules) {
    const resolvedRoot = canonicalizeIgnorePath(workspaceRoot);
    const hasNegation = rules.some((r) => r.negated);
    return {
        workspaceRoot: resolvedRoot,
        rules,
        isIgnored(targetPath, isDir = false) {
            if (rules.length === 0 || typeof targetPath !== 'string' || !targetPath.trim())
                return false;
            const rawTarget = path.isAbsolute(targetPath)
                ? path.resolve(targetPath)
                : path.resolve(resolvedRoot, targetPath);
            const resolvedTarget = canonicalizeIgnorePath(rawTarget);
            const rel = relativeIgnorePosix(resolvedRoot, resolvedTarget);
            if (!rel)
                return false;
            let ignored = false;
            for (const rule of rules) {
                if (ruleMatchesRelPath(rule, rel, isDir)) {
                    ignored = !rule.negated;
                }
            }
            return ignored;
        },
        toRipgrepGlobs() {
            // If any `!negation` rule exists, ripgrep's `-g <positive>` flag turns into an
            // inclusion whitelist that excludes unrelated files. Emit only safe negative globs
            // when there are no negations, and let callers always post-filter with `isIgnored()`.
            if (hasNegation)
                return [];
            const globs = [];
            for (const rule of rules) {
                if (rule.pattern.startsWith('-') || /[\x00-\x1f\r\n]/.test(rule.pattern))
                    continue;
                const base = rule.anchored ? `/${rule.pattern}` : rule.pattern;
                const suffix = rule.dirOnly ? '/**' : '';
                globs.push(`!${base}${suffix}`);
                if (!rule.dirOnly && !rule.pattern.includes('*') && !rule.pattern.includes('.')) {
                    globs.push(`!${base}/**`);
                }
            }
            return globs;
        }
    };
}
export function loadWorkspaceIgnoreMatcher(workspaceRoot, options = {}) {
    const resolvedRoot = path.resolve(workspaceRoot || process.cwd());
    const filenames = options.includeGitIgnore ? ['.gitignore', '.causyneignore'] : ['.causyneignore'];
    let mtimeSig = `${options.includeGitIgnore ? 'git+causyne' : 'causyne'}`;
    const existingFiles = [];
    for (const name of filenames) {
        const filePath = path.join(resolvedRoot, name);
        try {
            const stat = fs.lstatSync(filePath);
            if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_IGNORE_FILE_BYTES)
                continue;
            mtimeSig += `|${name}:${stat.mtimeMs}:${stat.size}`;
            existingFiles.push(filePath);
        }
        catch {
            mtimeSig += `|${name}:absent`;
        }
    }
    const cacheKey = `${resolvedRoot}::${options.includeGitIgnore ? '1' : '0'}`;
    const cached = matcherCache.get(cacheKey);
    if (cached && cached.mtimeSig === mtimeSig) {
        return cached.matcher;
    }
    const rules = [];
    for (const filePath of existingFiles) {
        try {
            const raw = fs.readFileSync(filePath, 'utf8');
            rules.push(...parseIgnoreContent(raw));
        }
        catch {
            continue;
        }
    }
    const matcher = createIgnoreMatcher(resolvedRoot, rules.slice(0, MAX_IGNORE_RULES));
    if (matcherCache.size >= 128 && !matcherCache.has(cacheKey)) {
        const oldest = matcherCache.keys().next().value;
        if (oldest !== undefined)
            matcherCache.delete(oldest);
    }
    matcherCache.set(cacheKey, { mtimeSig, matcher });
    return matcher;
}
export function isIgnoredByCausyneIgnore(targetPath, workspaceRoot, isDir = false) {
    if (!workspaceRoot || !targetPath)
        return false;
    return loadWorkspaceIgnoreMatcher(workspaceRoot, { includeGitIgnore: false }).isIgnored(targetPath, isDir);
}
