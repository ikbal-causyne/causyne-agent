/**
 * Causyne Agent — PageRank-Ranked Repository Architectural Map (Phase C-Core)
 *
 * Builds a compact, token-budgeted architectural outline of any codebase:
 *   1. Safely walks workspace source files (respects HEAVY_DEV_EXCLUDES, skips
 *      symlinks, binaries, and oversized files).
 *   2. Extracts declarations (`class`, `interface`, `type`, `function`, `const`,
 *      `def`, `struct`, `enum`, `trait`, `impl`, `func`) and import edges across
 *      TypeScript, JavaScript, Python, Go, Rust, and C/C++ with linear scanners.
 *   3. Ranks files by cross-file reference centrality (PageRank) + focus-file
 *      boosts so the most structurally important symbols fit inside `maxChars`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BINARY_EXTENSIONS_RE, HEAVY_DEV_EXCLUDES } from '../tools/walkerSafety.js';
import { safeDisplay } from '../tui/text.js';
const SOURCE_EXTENSIONS = Object.freeze({
    '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts',
    '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js',
    '.py': 'py', '.go': 'go', '.rs': 'rs',
    '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp',
    '.java': 'java', '.kt': 'kt', '.swift': 'swift', '.zig': 'zig'
});
const MAX_SCAN_FILES = 1500;
const MAX_SINGLE_FILE_BYTES = 256 * 1024;
const MAX_SYMBOLS_PER_FILE = 40;
const MAX_PARSE_CACHE_ENTRIES = 4000;
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,80}$/;
const repoMapParseCache = new Map();
export function clearRepoMapCache() {
    repoMapParseCache.clear();
}
function loadSimpleIgnorePatterns(root) {
    const entries = [];
    for (const filename of ['.gitignore', '.causyneignore']) {
        const filePath = path.join(root, filename);
        try {
            const stat = fs.lstatSync(filePath);
            if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 128 * 1024)
                continue;
            const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
            for (const rawLine of lines) {
                const trimmed = rawLine.trim();
                if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!'))
                    continue;
                const dirOnly = trimmed.endsWith('/');
                let pattern = dirOnly ? trimmed.slice(0, -1) : trimmed;
                const anchored = pattern.startsWith('/');
                if (anchored)
                    pattern = pattern.slice(1);
                if (!pattern)
                    continue;
                entries.push({ raw: pattern.replace(/\\/g, '/'), dirOnly, anchored });
                if (entries.length >= 256)
                    break;
            }
        }
        catch {
            continue;
        }
    }
    return entries;
}
function matchesSimpleGlob(text, pattern) {
    if (pattern === text)
        return true;
    if (!pattern.includes('*'))
        return false;
    // Linear single-wildcard / prefix-suffix check (zero ReDoS)
    const parts = pattern.split('*');
    if (parts.length === 2) {
        const [prefix, suffix] = parts;
        return text.length >= prefix.length + suffix.length && text.startsWith(prefix) && text.endsWith(suffix);
    }
    let pos = 0;
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part)
            continue;
        const found = text.indexOf(part, pos);
        if (found === -1)
            return false;
        if (i === 0 && !pattern.startsWith('*') && found !== 0)
            return false;
        pos = found + part.length;
    }
    if (!pattern.endsWith('*')) {
        const last = parts[parts.length - 1];
        if (last && !text.endsWith(last))
            return false;
    }
    return true;
}
function isIgnoredByRules(relPosix, basename, isDir, rules) {
    for (const rule of rules) {
        if (rule.dirOnly && !isDir)
            continue;
        if (rule.anchored || rule.raw.includes('/')) {
            if (relPosix === rule.raw || relPosix.startsWith(`${rule.raw}/`) || matchesSimpleGlob(relPosix, rule.raw)) {
                return true;
            }
        }
        else if (matchesSimpleGlob(basename, rule.raw)) {
            return true;
        }
    }
    return false;
}
function extractQuotedSpecifiers(line, keyword) {
    const out = [];
    let searchFrom = 0;
    while (searchFrom < line.length) {
        const idx = line.indexOf(keyword, searchFrom);
        if (idx === -1)
            break;
        let cursor = idx + keyword.length;
        while (cursor < line.length && (line[cursor] === ' ' || line[cursor] === '\t'))
            cursor++;
        const quote = line[cursor];
        if (quote === "'" || quote === '"') {
            const endQuote = line.indexOf(quote, cursor + 1);
            if (endQuote > cursor + 1) {
                out.push(line.slice(cursor + 1, endQuote));
                searchFrom = endQuote + 1;
                continue;
            }
        }
        searchFrom = idx + keyword.length;
    }
    return out;
}
function extractJsTsSymbolsAndImports(lines) {
    const symbols = [];
    const imports = [];
    let inMultilineImportOrExport = false;
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
            continue;
        // Single-line and multi-line ESM import/export extraction
        if (trimmed.startsWith('import ') || trimmed.startsWith('export ')) {
            const fromSpecs = extractQuotedSpecifiers(trimmed, ' from ');
            if (fromSpecs.length > 0) {
                imports.push(...fromSpecs);
                inMultilineImportOrExport = false;
            }
            else if (trimmed.startsWith('import ') && (trimmed.includes("'") || trimmed.includes('"')) && !trimmed.includes('{')) {
                // Side-effect import: import './polyfill.js'
                const sideEffect = extractQuotedSpecifiers(trimmed, 'import ');
                imports.push(...sideEffect);
                inMultilineImportOrExport = false;
            }
            else if (trimmed.includes('{') && !trimmed.includes('}')) {
                inMultilineImportOrExport = true;
            }
        }
        else if (inMultilineImportOrExport) {
            const fromSpecs = extractQuotedSpecifiers(trimmed, ' from ');
            if (fromSpecs.length > 0) {
                imports.push(...fromSpecs);
                inMultilineImportOrExport = false;
            }
            else if (trimmed.includes(';')) {
                inMultilineImportOrExport = false;
            }
        }
        // CommonJS require('...') and dynamic import('...')
        if (trimmed.includes('require(')) {
            imports.push(...extractQuotedSpecifiers(trimmed, 'require('));
        }
        if (trimmed.includes('import(')) {
            imports.push(...extractQuotedSpecifiers(trimmed, 'import('));
        }
        if (symbols.length >= MAX_SYMBOLS_PER_FILE)
            continue;
        // Only top-level or lightly indented declarations
        const indent = raw.length - raw.trimStart().length;
        if (indent > 2)
            continue;
        let rest = trimmed;
        let exported = false;
        if (rest.startsWith('export ')) {
            exported = true;
            rest = rest.slice('export '.length).trim();
            if (rest.startsWith('default '))
                rest = rest.slice('default '.length).trim();
            if (rest.startsWith('declare '))
                rest = rest.slice('declare '.length).trim();
        }
        if (rest.startsWith('async '))
            rest = rest.slice('async '.length).trim();
        if (rest.startsWith('abstract '))
            rest = rest.slice('abstract '.length).trim();
        const keywords = [
            ['function ', 'fn'],
            ['class ', 'class'],
            ['interface ', 'interface'],
            ['type ', 'type'],
            ['enum ', 'enum'],
            ['const ', 'const']
        ];
        for (const [prefix, kind] of keywords) {
            if (!rest.startsWith(prefix))
                continue;
            if (kind === 'const' && !exported)
                continue;
            const after = rest.slice(prefix.length).trim();
            let end = 0;
            while (end < after.length && /[A-Za-z0-9_$]/.test(after[end]))
                end++;
            const name = after.slice(0, end);
            if (IDENT_RE.test(name)) {
                symbols.push({ kind, name, line: i + 1, exported });
            }
            break;
        }
    }
    return { symbols, imports };
}
function extractPythonSymbolsAndImports(lines) {
    const symbols = [];
    const imports = [];
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith('#'))
            continue;
        if (trimmed.startsWith('from ')) {
            const impIdx = trimmed.indexOf(' import ');
            if (impIdx > 5)
                imports.push(trimmed.slice(5, impIdx).trim());
            continue;
        }
        if (trimmed.startsWith('import ')) {
            imports.push(trimmed.slice(7).split(',')[0].trim().split(/\s+/)[0] || '');
            continue;
        }
        if (symbols.length >= MAX_SYMBOLS_PER_FILE)
            continue;
        const indent = raw.length - raw.trimStart().length;
        if (indent > 4)
            continue;
        let rest = trimmed;
        if (rest.startsWith('async '))
            rest = rest.slice(6).trim();
        const kind = rest.startsWith('class ') ? 'class' : (rest.startsWith('def ') ? 'def' : null);
        if (!kind)
            continue;
        const after = rest.slice(kind.length + 1).trim();
        let end = 0;
        while (end < after.length && /[A-Za-z0-9_]/.test(after[end]))
            end++;
        const name = after.slice(0, end);
        if (IDENT_RE.test(name)) {
            symbols.push({ kind, name, line: i + 1, exported: !name.startsWith('_') });
        }
    }
    return { symbols, imports: imports.filter(Boolean) };
}
function extractGenericSymbols(lines, lang) {
    const symbols = [];
    const imports = [];
    let inGoImportBlock = false;
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*'))
            continue;
        // Multi-language import extraction
        if (lang === 'go') {
            if (trimmed === 'import (' || trimmed.startsWith('import (')) {
                inGoImportBlock = true;
                continue;
            }
            if (inGoImportBlock) {
                if (trimmed.startsWith(')')) {
                    inGoImportBlock = false;
                    continue;
                }
                const q1 = trimmed.indexOf('"');
                const q2 = q1 !== -1 ? trimmed.indexOf('"', q1 + 1) : -1;
                if (q1 !== -1 && q2 > q1 + 1)
                    imports.push(trimmed.slice(q1 + 1, q2));
                continue;
            }
            if (trimmed.startsWith('import ')) {
                const q1 = trimmed.indexOf('"');
                const q2 = q1 !== -1 ? trimmed.indexOf('"', q1 + 1) : -1;
                if (q1 !== -1 && q2 > q1 + 1)
                    imports.push(trimmed.slice(q1 + 1, q2));
            }
        }
        else if (lang === 'rs') {
            if (trimmed.startsWith('use crate::') || trimmed.startsWith('use super::') || trimmed.startsWith('use self::')) {
                const spec = trimmed.slice(4).split(/[;{\s]/)[0] || '';
                if (spec)
                    imports.push(spec);
            }
            else if (trimmed.startsWith('mod ') || trimmed.startsWith('pub mod ')) {
                const afterMod = trimmed.startsWith('pub mod ') ? trimmed.slice(8) : trimmed.slice(4);
                const modName = afterMod.split(/[;{\s]/)[0] || '';
                if (IDENT_RE.test(modName))
                    imports.push(`self::${modName}`);
            }
        }
        else if (lang === 'c' || lang === 'cpp') {
            if (trimmed.startsWith('#include "')) {
                const endQ = trimmed.indexOf('"', 10);
                if (endQ > 10)
                    imports.push(`./${trimmed.slice(10, endQ)}`);
            }
        }
        else if (lang === 'java' || lang === 'kt') {
            if (trimmed.startsWith('import ')) {
                const spec = trimmed.slice(7).replace(/^static\s+/, '').replace(/;$/, '').trim();
                if (spec)
                    imports.push(spec);
            }
        }
        if (symbols.length >= MAX_SYMBOLS_PER_FILE)
            continue;
        const indent = raw.length - raw.trimStart().length;
        if (indent > 4)
            continue;
        let rest = trimmed;
        let exported = false;
        if (lang === 'rs' && rest.startsWith('pub ')) {
            exported = true;
            rest = rest.slice(4).trim();
            if (rest.startsWith('async '))
                rest = rest.slice(6).trim();
        }
        else if ((lang === 'java' || lang === 'kt' || lang === 'swift') && rest.startsWith('public ')) {
            exported = true;
            rest = rest.slice(7).trim();
            for (const mod of ['static ', 'final ', 'abstract ', 'sealed ', 'data ', 'open ']) {
                if (rest.startsWith(mod))
                    rest = rest.slice(mod.length).trim();
            }
        }
        else if (lang === 'kt') {
            for (const mod of ['data ', 'sealed ', 'open ', 'suspend ']) {
                if (rest.startsWith(mod))
                    rest = rest.slice(mod.length).trim();
            }
        }
        const prefixes = lang === 'go'
            ? [['func ', 'func'], ['type ', 'type']]
            : lang === 'rs'
                ? [['fn ', 'fn'], ['struct ', 'struct'], ['enum ', 'enum'], ['trait ', 'trait'], ['impl ', 'impl']]
                : lang === 'java'
                    ? [['class ', 'class'], ['interface ', 'interface'], ['record ', 'record'], ['enum ', 'enum']]
                    : lang === 'kt'
                        ? [['class ', 'class'], ['interface ', 'interface'], ['object ', 'object'], ['fun ', 'fun'], ['enum class ', 'enum']]
                        : [['class ', 'class'], ['struct ', 'struct'], ['enum ', 'enum'], ['fn ', 'fn'], ['func ', 'func']];
        for (const [prefix, kind] of prefixes) {
            if (!rest.startsWith(prefix))
                continue;
            let after = rest.slice(prefix.length).trim();
            if (lang === 'go' && kind === 'func' && after.startsWith('(')) {
                const close = after.indexOf(')');
                if (close !== -1)
                    after = after.slice(close + 1).trim();
            }
            let end = 0;
            while (end < after.length && /[A-Za-z0-9_]/.test(after[end]))
                end++;
            const name = after.slice(0, end);
            if (IDENT_RE.test(name)) {
                const isGoExport = lang === 'go' && name.length > 0 && name[0] >= 'A' && name[0] <= 'Z';
                symbols.push({ kind, name, line: i + 1, exported: exported || isGoExport });
            }
            break;
        }
    }
    return { symbols, imports };
}
function resolveImportTarget(fromRelPath, importSpec, lang, knownFiles) {
    if (!importSpec)
        return null;
    const baseDir = path.posix.dirname(fromRelPath);
    // Relative POSIX imports (JS/TS, C/C++ #include "./foo.h")
    if (importSpec.startsWith('./') || importSpec.startsWith('../')) {
        const joined = path.posix.normalize(path.posix.join(baseDir, importSpec));
        if (knownFiles.has(joined))
            return joined;
        const stem = joined.replace(/\.(js|mjs|cjs|jsx)$/, '');
        const tryExts = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.py', '.h', '.hpp', '/index.ts', '/index.js'];
        for (const ext of tryExts) {
            const candidate = `${stem}${ext}`;
            if (knownFiles.has(candidate))
                return candidate;
        }
        return null;
    }
    // Python relative (.foo / ..bar.baz) and dotted intra-repo imports (pkg.mod)
    if (lang === 'py') {
        let dots = 0;
        while (dots < importSpec.length && importSpec[dots] === '.')
            dots++;
        const remainder = importSpec.slice(dots).replace(/\./g, '/');
        let anchor = baseDir === '.' ? '' : baseDir;
        if (dots > 1) {
            for (let up = 1; up < dots; up++) {
                anchor = path.posix.dirname(anchor);
            }
        }
        const candidates = [];
        if (dots > 0) {
            const joined = path.posix.normalize(path.posix.join(anchor || '.', remainder));
            candidates.push(`${joined}.py`, `${joined}/__init__.py`);
        }
        else if (remainder) {
            candidates.push(`${remainder}.py`, `${remainder}/__init__.py`, `src/${remainder}.py`, `src/${remainder}/__init__.py`);
        }
        for (const c of candidates) {
            const clean = c.replace(/^\.\//, '');
            if (knownFiles.has(clean))
                return clean;
        }
        return null;
    }
    // Rust intra-crate imports (crate::foo::bar, self::foo, super::foo)
    if (lang === 'rs' && (importSpec.startsWith('crate::') || importSpec.startsWith('self::') || importSpec.startsWith('super::'))) {
        const parts = importSpec.split('::').filter(Boolean);
        const kind = parts.shift();
        const firstSeg = parts[0] || '';
        if (!firstSeg)
            return null;
        const targetDir = kind === 'crate'
            ? (baseDir.startsWith('src') ? 'src' : '.')
            : (kind === 'super' ? path.posix.dirname(baseDir) : baseDir);
        const joined = path.posix.normalize(path.posix.join(targetDir, ...parts));
        const singleJoined = path.posix.normalize(path.posix.join(targetDir, firstSeg));
        for (const stem of [joined, singleJoined]) {
            for (const suffix of ['.rs', '/mod.rs']) {
                const clean = `${stem}${suffix}`.replace(/^\.\//, '');
                if (knownFiles.has(clean))
                    return clean;
            }
        }
        return null;
    }
    // Java / Kotlin / Go intra-repo suffix match (e.g. com.acme.Core -> .../Core.java or pkg/sub -> .../sub/*.go)
    if (lang === 'java' || lang === 'kt') {
        const asPath = importSpec.replace(/\./g, '/');
        const ext = lang === 'java' ? '.java' : '.kt';
        const tail = `${asPath}${ext}`;
        for (const known of knownFiles) {
            if (known === tail || known.endsWith(`/${tail}`))
                return known;
        }
        return null;
    }
    if (lang === 'go') {
        const segments = importSpec.split('/').filter(Boolean);
        const pkgTail = segments.slice(-2).join('/');
        if (!pkgTail)
            return null;
        for (const known of knownFiles) {
            if (known.endsWith('.go') && (known.includes(`/${pkgTail}/`) || known.startsWith(`${pkgTail}/`))) {
                return known;
            }
        }
        return null;
    }
    return null;
}
export function buildRepoMap(workspaceRoot, options = {}) {
    const root = path.resolve(workspaceRoot);
    const maxFiles = Math.max(10, Math.min(MAX_SCAN_FILES, options.maxFiles ?? 400));
    const maxChars = Math.max(400, Math.min(48_000, options.maxChars ?? 6_000));
    const focusSet = new Set((options.focusFiles ?? [])
        .filter((f) => typeof f === 'string' && f.trim().length > 0)
        .map((f) => path.relative(root, path.resolve(root, f.trim())).replace(/\\/g, '/')));
    // Bounded BFS walk (maps shallower root modules across the full tree before deep leaves; skips symlinks & ignored paths)
    const ignoreRules = loadSimpleIgnorePatterns(root);
    const discovered = [];
    const queue = [{ dir: root, depth: 0 }];
    let queueHead = 0;
    let totalSourceFiles = 0;
    while (queueHead < queue.length) {
        const { dir, depth } = queue[queueHead++];
        if (depth > 12)
            continue;
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            if (entry.isSymbolicLink())
                continue;
            const absEntry = path.join(dir, entry.name);
            const relEntry = path.relative(root, absEntry).replace(/\\/g, '/');
            if (entry.isDirectory()) {
                if (HEAVY_DEV_EXCLUDES.has(entry.name)
                    || entry.name === '.causyne-worktrees'
                    || entry.name.startsWith('.')
                    || isIgnoredByRules(relEntry, entry.name, true, ignoreRules)) {
                    continue;
                }
                queue.push({ dir: absEntry, depth: depth + 1 });
                continue;
            }
            if (!entry.isFile())
                continue;
            if (BINARY_EXTENSIONS_RE.test(entry.name))
                continue;
            if (isIgnoredByRules(relEntry, entry.name, false, ignoreRules))
                continue;
            const ext = path.extname(entry.name).toLowerCase();
            const language = SOURCE_EXTENSIONS[ext];
            if (!language)
                continue;
            totalSourceFiles++;
            if (discovered.length >= maxFiles)
                continue;
            discovered.push({ absPath: absEntry, relPath: relEntry, language });
        }
    }
    const knownRelSet = new Set(discovered.map((d) => d.relPath));
    const nodes = [];
    for (const item of discovered) {
        let stat;
        try {
            stat = fs.lstatSync(item.absPath);
            if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_SINGLE_FILE_BYTES)
                continue;
        }
        catch {
            continue;
        }
        const cacheKey = `${item.absPath}::${item.language}`;
        const cached = repoMapParseCache.get(cacheKey);
        let extracted;
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
            extracted = { symbols: cached.symbols, imports: cached.imports };
        }
        else {
            let text = '';
            try {
                text = fs.readFileSync(item.absPath, 'utf8');
            }
            catch {
                continue;
            }
            const lines = text.split(/\r?\n/);
            extracted = (item.language === 'ts' || item.language === 'js')
                ? extractJsTsSymbolsAndImports(lines)
                : item.language === 'py'
                    ? extractPythonSymbolsAndImports(lines)
                    : extractGenericSymbols(lines, item.language);
            if (repoMapParseCache.size >= MAX_PARSE_CACHE_ENTRIES && !repoMapParseCache.has(cacheKey)) {
                const oldest = repoMapParseCache.keys().next().value;
                if (oldest !== undefined)
                    repoMapParseCache.delete(oldest);
            }
            repoMapParseCache.set(cacheKey, {
                mtimeMs: stat.mtimeMs,
                size: stat.size,
                symbols: extracted.symbols,
                imports: extracted.imports
            });
        }
        nodes.push({
            relPath: item.relPath,
            absPath: item.absPath,
            language: item.language,
            symbols: extracted.symbols,
            imports: extracted.imports,
            rank: 1
        });
    }
    // Build directed dependency graph & run 6-iteration PageRank centrality
    const indexByRel = new Map();
    nodes.forEach((n, idx) => indexByRel.set(n.relPath, idx));
    const outgoing = nodes.map(() => []);
    const incoming = nodes.map(() => []);
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        for (const spec of node.imports) {
            const resolved = resolveImportTarget(node.relPath, spec, node.language, knownRelSet);
            if (!resolved)
                continue;
            const targetIdx = indexByRel.get(resolved);
            if (targetIdx !== undefined && targetIdx !== i) {
                outgoing[i].push(targetIdx);
                incoming[targetIdx].push(i);
            }
        }
    }
    const n = nodes.length;
    if (n > 0) {
        const damping = 0.85;
        let scores = new Float64Array(n).fill(1 / n);
        for (let iter = 0; iter < 6; iter++) {
            const next = new Float64Array(n);
            const baseTeleport = (1 - damping) / n;
            let totalScore = 0;
            for (let i = 0; i < n; i++) {
                let sum = 0;
                for (const src of incoming[i]) {
                    const deg = outgoing[src].length;
                    if (deg > 0)
                        sum += scores[src] / deg;
                }
                next[i] = baseTeleport + damping * sum;
                totalScore += next[i];
            }
            if (totalScore > 0) {
                for (let i = 0; i < n; i++)
                    next[i] = next[i] / totalScore;
            }
            scores = next;
        }
        for (let i = 0; i < n; i++) {
            const focusBoost = focusSet.has(nodes[i].relPath) ? 1.0 : 0;
            const exportBoost = Math.min(0.05, nodes[i].symbols.filter((s) => s.exported).length * 0.004);
            nodes[i].rank = Number((scores[i] + focusBoost + exportBoost).toFixed(5));
        }
    }
    nodes.sort((a, b) => b.rank - a.rank || a.relPath.localeCompare(b.relPath));
    // Render token-budgeted architectural outline
    const header = `# Repository Map (${nodes.length}/${totalSourceFiles} source file(s), ranked by dependency centrality)\n`;
    const chunks = [header];
    let charBudgetUsed = header.length;
    let mappedFiles = 0;
    let truncated = totalSourceFiles > nodes.length;
    for (const node of nodes) {
        const symList = node.symbols.slice(0, 12).map((s) => `${s.kind} ${s.name}:${s.line}`).join(', ');
        const line = symList
            ? `${safeDisplay(node.relPath)}  [rank=${node.rank.toFixed(3)}]\n  ${safeDisplay(symList)}\n`
            : `${safeDisplay(node.relPath)}  [rank=${node.rank.toFixed(3)}]\n`;
        if (charBudgetUsed + line.length > maxChars) {
            truncated = true;
            break;
        }
        chunks.push(line);
        charBudgetUsed += line.length;
        mappedFiles++;
    }
    return {
        workspaceRoot: root,
        totalSourceFiles,
        mappedFiles,
        truncated,
        files: nodes,
        rendered: chunks.join('')
    };
}
