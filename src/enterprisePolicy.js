/**
 * Causyne Agent — Declarative Enterprise Policy Engine (Phase A)
 *
 * Loads and enforces organization/workspace tool rules (`causyne.policy.json`)
 * deterministically outside the model. Precedence:
 *   1. `deny` always wins (blocks execution, logged to auditLog)
 *   2. `ask` forces explicit human approval (overrides Mode C & standing grants)
 *   3. `allow` skips interactive prompt for non-destructive in-scope actions
 *   4. `defaultEffect` (when configured) applies if no rule matched
 *
 * Security invariants:
 *   - Fail-closed when a discovered policy file is unreadable, symlinked,
 *     oversized (>256 KiB), or malformed JSON.
 *   - Pure iterative linear wildcard/glob matcher — zero dynamic RegExp
 *     construction, zero ReDoS surface.
 *   - Never strips or degrades ACP peer capabilities, and never overrides
 *     Sandbox workspace boundaries or Cold Observer vetoes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from './utils/paths.js';
import { safeDisplay } from './tui/text.js';
import { extractPatchTargetPaths } from './tools/applyPatch.js';
import { analyzeShellCommand } from './sandboxPolicy.js';
import { physicalPath } from './agent/workspaceBoundary.js';
const MAX_POLICY_FILE_BYTES = 256 * 1024;
const MAX_RULES_PER_BUCKET = 512;
const MAX_PATTERN_LENGTH = 512;
const MAX_MATCH_TEXT_LENGTH = 8192;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SHELL_TOOL_NAMES = new Set(['sysRun', 'sysRunBg', 'terminal_persistent_shell', 'task_bg', 'gitOp']);
const PATH_ARG_KEYS = [
    'path', 'filePath', 'file_path', 'filepath', 'searchPath', 'workdir', 'inputPath',
    'targetFile', 'targetPath', 'source', 'destination', 'dest', 'outputFile', 'outputPath',
    'outFile', 'previewFile', 'outputFileName', 'outputDir', 'projectDir', 'scenePath',
    'cwd', 'dir', 'directory', 'file', 'target', 'root'
];
const URL_ARG_KEYS = ['url', 'href', 'endpoint', 'assetUrl', 'uri'];
const policyFileCache = new Map();
export function clearEnterprisePolicyCache() {
    policyFileCache.clear();
}
function emptyBucket() {
    return { allow: [], ask: [], deny: [] };
}
function normalizePatternList(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const item of raw) {
        if (out.length >= MAX_RULES_PER_BUCKET)
            break;
        if (typeof item !== 'string')
            continue;
        const trimmed = item.trim();
        if (!trimmed || trimmed.length > MAX_PATTERN_LENGTH || trimmed.includes('\0'))
            continue;
        out.push(trimmed);
    }
    return out;
}
function parseRuleBucket(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return emptyBucket();
    const obj = raw;
    return {
        allow: normalizePatternList(obj.allow),
        ask: normalizePatternList(obj.ask),
        deny: normalizePatternList(obj.deny)
    };
}
function stripForbiddenKeys(value, depth = 0) {
    if (depth > 12 || value === null || typeof value !== 'object')
        return value;
    if (Array.isArray(value))
        return value.map((item) => stripForbiddenKeys(item, depth + 1));
    const out = Object.create(null);
    for (const [k, v] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.has(k))
            continue;
        out[k] = stripForbiddenKeys(v, depth + 1);
    }
    return out;
}
/**
 * Iterative O(N * M) wildcard matcher supporting `*`, `**`, and `?`.
 * No RegExp compilation — immune to ReDoS and regex injection.
 */
export function matchWildcard(pattern, text, caseInsensitive = false) {
    if (typeof pattern !== 'string' || typeof text !== 'string')
        return false;
    if (pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH)
        return false;
    const boundedText = text.length > MAX_MATCH_TEXT_LENGTH ? text.slice(0, MAX_MATCH_TEXT_LENGTH) : text;
    // Collapse consecutive `*` runs (`**` behaves identically to `*` over normalized strings)
    let normPattern = '';
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === '*' && normPattern.endsWith('*'))
            continue;
        normPattern += ch;
    }
    const p = caseInsensitive ? normPattern.toLowerCase() : normPattern;
    const s = caseInsensitive ? boundedText.toLowerCase() : boundedText;
    let pi = 0;
    let si = 0;
    let starIdx = -1;
    let matchIdx = 0;
    while (si < s.length) {
        if (pi < p.length && (p[pi] === '?' || p[pi] === s[si])) {
            pi++;
            si++;
        }
        else if (pi < p.length && p[pi] === '*') {
            starIdx = pi;
            matchIdx = si;
            pi++;
        }
        else if (starIdx !== -1) {
            pi = starIdx + 1;
            matchIdx++;
            si = matchIdx;
        }
        else {
            return false;
        }
    }
    while (pi < p.length && p[pi] === '*')
        pi++;
    return pi === p.length;
}
export function systemManagedPolicyPath(env = process.env) {
    const override = typeof env.CAUSYNE_MANAGED_POLICY_FILE === 'string' ? env.CAUSYNE_MANAGED_POLICY_FILE.trim() : '';
    if (override && !override.includes('\0'))
        return path.resolve(override);
    if (process.platform === 'darwin') {
        return '/Library/Application Support/Causyne/policy.json';
    }
    if (process.platform === 'win32') {
        const programData = typeof env.ProgramData === 'string' && env.ProgramData.trim()
            ? env.ProgramData.trim()
            : 'C:\\ProgramData';
        return path.join(programData, 'Causyne', 'policy.json');
    }
    return '/etc/causyne/policy.json';
}
export function discoverPolicyPaths(workspaceRoot, env = process.env) {
    const candidates = [];
    const pushUnique = (candidate) => {
        const resolved = path.resolve(candidate);
        if (!candidates.includes(resolved))
            candidates.push(resolved);
    };
    // Highest-precedence tier first: IT/System Managed -> User Global -> Workspace / Explicit override
    pushUnique(systemManagedPolicyPath(env));
    const home = env.CAUSYNE_HOME && String(env.CAUSYNE_HOME).trim()
        ? path.resolve(String(env.CAUSYNE_HOME).trim())
        : causyneHome();
    pushUnique(path.join(home, 'policy.json'));
    if (typeof workspaceRoot === 'string' && workspaceRoot.trim() && !workspaceRoot.includes('\0')) {
        const resolvedWs = path.resolve(workspaceRoot);
        pushUnique(path.join(resolvedWs, 'causyne.policy.json'));
        pushUnique(path.join(resolvedWs, '.causyne', 'policy.json'));
    }
    const envFile = typeof env.CAUSYNE_POLICY_FILE === 'string' ? env.CAUSYNE_POLICY_FILE.trim() : '';
    if (envFile && !envFile.includes('\0')) {
        pushUnique(envFile);
    }
    return candidates;
}
function readSinglePolicyFile(selectedPath) {
    try {
        const stat = fs.lstatSync(selectedPath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            return {
                policy: null,
                error: `Refusing symlink or non-regular enterprise policy file: ${safeDisplay(selectedPath)}`
            };
        }
        if (stat.size > MAX_POLICY_FILE_BYTES) {
            return {
                policy: null,
                error: `Enterprise policy file exceeds maximum size of ${MAX_POLICY_FILE_BYTES} bytes.`
            };
        }
        const cached = policyFileCache.get(selectedPath);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs && cached.size === stat.size) {
            return { policy: cached.policy, error: cached.error };
        }
        const rawText = fs.readFileSync(selectedPath, 'utf8').replace(/^\uFEFF/, '');
        const parsedRaw = JSON.parse(rawText);
        if (!parsedRaw || typeof parsedRaw !== 'object' || Array.isArray(parsedRaw)) {
            const error = 'Enterprise policy file must contain a JSON object.';
            policyFileCache.set(selectedPath, { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size, policy: null, error });
            return { policy: null, error };
        }
        const clean = stripForbiddenKeys(parsedRaw);
        const version = clean.version === undefined ? 1 : Number(clean.version);
        if (version !== 1) {
            const error = `Unsupported enterprise policy version "${String(clean.version)}". Expected version 1.`;
            policyFileCache.set(selectedPath, { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size, policy: null, error });
            return { policy: null, error };
        }
        let defaultEffect;
        if (clean.defaultEffect !== undefined) {
            if (clean.defaultEffect === 'allow' || clean.defaultEffect === 'ask' || clean.defaultEffect === 'deny') {
                defaultEffect = clean.defaultEffect;
            }
            else {
                const error = `Invalid defaultEffect "${String(clean.defaultEffect)}". Expected "allow", "ask", or "deny".`;
                policyFileCache.set(selectedPath, { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size, policy: null, error });
                return { policy: null, error };
            }
        }
        const policy = {
            version: 1,
            defaultEffect,
            tools: parseRuleBucket(clean.tools),
            commands: parseRuleBucket(clean.commands),
            paths: parseRuleBucket(clean.paths),
            domains: parseRuleBucket(clean.domains),
            mcpServers: parseRuleBucket(clean.mcpServers)
        };
        policyFileCache.set(selectedPath, { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size, policy, error: null });
        return { policy, error: null };
    }
    catch (err) {
        return {
            policy: null,
            error: `Invalid enterprise policy file: ${err instanceof Error ? err.message : String(err)}`
        };
    }
}
function mergePatternLists(a, b) {
    const out = [];
    const seen = new Set();
    for (const list of [a, b]) {
        for (const item of list) {
            if (out.length >= MAX_RULES_PER_BUCKET)
                return out;
            if (!seen.has(item)) {
                seen.add(item);
                out.push(item);
            }
        }
    }
    return out;
}
function mergeRuleBuckets(upper, lower) {
    return {
        allow: mergePatternLists(upper.allow, lower.allow),
        ask: mergePatternLists(upper.ask, lower.ask),
        deny: mergePatternLists(upper.deny, lower.deny)
    };
}
function stricterDefaultEffect(upper, lower) {
    const rank = (effect) => {
        if (effect === 'deny')
            return 3;
        if (effect === 'ask')
            return 2;
        if (effect === 'allow')
            return 1;
        return 0;
    };
    return rank(lower) > rank(upper) ? lower : upper;
}
export function loadEnterprisePolicy(workspaceRoot, env = process.env) {
    const envFile = typeof env.CAUSYNE_POLICY_FILE === 'string' ? env.CAUSYNE_POLICY_FILE.trim() : '';
    const resolvedEnvFile = envFile && !envFile.includes('\0') ? path.resolve(envFile) : '';
    const managedOverride = typeof env.CAUSYNE_MANAGED_POLICY_FILE === 'string' ? env.CAUSYNE_MANAGED_POLICY_FILE.trim() : '';
    const resolvedManagedOverride = managedOverride && !managedOverride.includes('\0') ? path.resolve(managedOverride) : '';
    const candidates = discoverPolicyPaths(workspaceRoot, env);
    const existingPaths = [];
    for (const candidate of candidates) {
        try {
            fs.lstatSync(candidate);
            existingPaths.push(candidate);
        }
        catch (err) {
            const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : '';
            if (code === 'ENOENT' || code === 'ENOTDIR') {
                if (resolvedEnvFile && candidate === resolvedEnvFile) {
                    return {
                        found: true,
                        sourcePath: candidate,
                        sourcePaths: [candidate],
                        policy: null,
                        error: `Configured CAUSYNE_POLICY_FILE does not exist: ${safeDisplay(candidate)}`
                    };
                }
                if (resolvedManagedOverride && candidate === resolvedManagedOverride) {
                    return {
                        found: true,
                        sourcePath: candidate,
                        sourcePaths: [candidate],
                        policy: null,
                        error: `Configured CAUSYNE_MANAGED_POLICY_FILE does not exist: ${safeDisplay(candidate)}`
                    };
                }
                continue;
            }
            // Permission-denied on default system managed path is only fatal if explicitly configured
            if ((code === 'EACCES' || code === 'EPERM') && !resolvedManagedOverride && candidate === systemManagedPolicyPath(env)) {
                continue;
            }
            return {
                found: true,
                sourcePath: candidate,
                sourcePaths: [candidate],
                policy: null,
                error: `Could not inspect policy file ${safeDisplay(candidate)}: ${err instanceof Error ? err.message : String(err)}`
            };
        }
    }
    if (existingPaths.length === 0) {
        return { found: false, sourcePath: null, sourcePaths: [], policy: null, error: null };
    }
    // Layer additively from highest-precedence tier (system managed -> user -> workspace -> env override).
    // Lower tiers can only tighten deny/ask/defaultEffect; they can never erase higher-tier restrictions.
    let merged = null;
    for (const layerPath of existingPaths) {
        const parsed = readSinglePolicyFile(layerPath);
        if (parsed.error || !parsed.policy) {
            return {
                found: true,
                sourcePath: layerPath,
                sourcePaths: existingPaths,
                policy: null,
                error: parsed.error || `Enterprise policy file failed to load: ${safeDisplay(layerPath)}`
            };
        }
        if (!merged) {
            merged = {
                version: 1,
                defaultEffect: parsed.policy.defaultEffect,
                tools: { ...parsed.policy.tools },
                commands: { ...parsed.policy.commands },
                paths: { ...parsed.policy.paths },
                domains: { ...parsed.policy.domains },
                mcpServers: { ...parsed.policy.mcpServers }
            };
        }
        else {
            merged = {
                version: 1,
                defaultEffect: stricterDefaultEffect(merged.defaultEffect, parsed.policy.defaultEffect),
                tools: mergeRuleBuckets(merged.tools, parsed.policy.tools),
                commands: mergeRuleBuckets(merged.commands, parsed.policy.commands),
                paths: mergeRuleBuckets(merged.paths, parsed.policy.paths),
                domains: mergeRuleBuckets(merged.domains, parsed.policy.domains),
                mcpServers: mergeRuleBuckets(merged.mcpServers, parsed.policy.mcpServers)
            };
        }
    }
    return {
        found: true,
        sourcePath: existingPaths[existingPaths.length - 1] ?? null,
        sourcePaths: existingPaths,
        policy: merged,
        error: null
    };
}
function canonicalTool(tool) {
    return String(tool || '').trim().replace(/\./g, '_');
}
function extractMcpServer(tool) {
    if (!tool.startsWith('mcp__'))
        return null;
    const rest = tool.slice('mcp__'.length);
    const idx = rest.indexOf('__');
    return idx > 0 ? rest.slice(0, idx) : null;
}
function extractCommandStrings(tool, args) {
    if (!SHELL_TOOL_NAMES.has(tool))
        return [];
    const out = new Set();
    const addSegmented = (cmdText) => {
        const trimmed = cmdText.trim();
        if (!trimmed)
            return;
        out.add(trimmed);
        try {
            const analyzed = analyzeShellCommand(trimmed);
            for (const unit of analyzed.allRawUnits) {
                if (unit.trim())
                    out.add(unit.trim());
            }
            for (const seg of analyzed.normalizedSegments) {
                if (seg.normalized.trim())
                    out.add(seg.normalized.trim());
            }
            for (const seg of analyzed.unwrappedRawSegments) {
                if (seg.normalized.trim())
                    out.add(seg.normalized.trim());
            }
        }
        catch {
            // Fallback to raw trimmed command
        }
    };
    if (tool === 'gitOp') {
        const raw = typeof args.command === 'string' ? args.command : typeof args.action === 'string' ? args.action : '';
        const trimmed = raw.trim();
        if (trimmed) {
            addSegmented(`git ${trimmed}`);
            out.add(trimmed);
        }
        return [...out];
    }
    const cmd = typeof args.command === 'string'
        ? args.command
        : typeof args.cmd === 'string'
            ? args.cmd
            : typeof args.input === 'string'
                ? args.input
                : '';
    addSegmented(cmd);
    return [...out];
}
function normalizePosixPath(value) {
    return value.replace(/\\/g, '/');
}
function extractPathCandidates(args, workspaceRoot) {
    const out = new Set();
    const resolvedRoot = workspaceRoot ? path.resolve(workspaceRoot) : null;
    const physicalRoot = resolvedRoot ? (physicalPath(resolvedRoot) || resolvedRoot) : null;
    const addPath = (raw) => {
        if (typeof raw !== 'string')
            return;
        const trimmed = raw.trim();
        if (!trimmed || trimmed.includes('\0'))
            return;
        out.add(normalizePosixPath(trimmed));
        const abs = resolvedRoot && !path.isAbsolute(trimmed)
            ? path.resolve(resolvedRoot, trimmed)
            : path.resolve(trimmed);
        out.add(normalizePosixPath(abs));
        if (resolvedRoot) {
            const rel = path.relative(resolvedRoot, abs);
            if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
                out.add(normalizePosixPath(rel));
            }
        }
        const real = physicalPath(abs);
        if (real) {
            out.add(normalizePosixPath(real));
            if (physicalRoot) {
                const realRel = path.relative(physicalRoot, real);
                if (realRel && !realRel.startsWith('..') && !path.isAbsolute(realRel)) {
                    out.add(normalizePosixPath(realRel));
                }
            }
        }
    };
    for (const key of PATH_ARG_KEYS) {
        if (Object.hasOwn(args, key))
            addPath(args[key]);
    }
    if (Array.isArray(args.target_directories)) {
        for (const dir of args.target_directories.slice(0, 64)) {
            addPath(dir);
        }
    }
    if (Array.isArray(args.files)) {
        for (const file of args.files.slice(0, 64)) {
            addPath(file);
        }
    }
    if (Array.isArray(args.edits)) {
        for (const edit of args.edits.slice(0, 64)) {
            if (edit && typeof edit === 'object' && 'path' in edit) {
                addPath(edit.path);
            }
        }
    }
    if (typeof args.patch === 'string') {
        for (const target of extractPatchTargetPaths(args.patch).paths) {
            addPath(target);
        }
    }
    return [...out];
}
function extractDomains(args) {
    const out = new Set();
    const addUrl = (raw) => {
        if (typeof raw !== 'string' || !raw.trim())
            return;
        try {
            const parsed = new URL(raw.trim());
            if (parsed.hostname)
                out.add(parsed.hostname.toLowerCase());
        }
        catch {
            // Not a full URL
        }
    };
    for (const key of URL_ARG_KEYS) {
        if (Object.hasOwn(args, key))
            addUrl(args[key]);
    }
    if (Array.isArray(args.actions)) {
        for (const act of args.actions.slice(0, 64)) {
            if (act && typeof act === 'object' && 'url' in act) {
                addUrl(act.url);
            }
        }
    }
    return [...out];
}
function firstMatch(patterns, candidates, caseInsensitive = false) {
    for (const pattern of patterns) {
        for (const candidate of candidates) {
            if (matchWildcard(pattern, candidate, caseInsensitive)) {
                return pattern;
            }
        }
    }
    return null;
}
/**
 * Evaluates a tool invocation against a loaded enterprise policy.
 * Always prioritizes `deny` > `ask` > `allow` > `defaultEffect`.
 */
export function evaluateEnterprisePolicy(input, loaded) {
    const state = loaded ?? loadEnterprisePolicy(input.workspaceRoot, input.env);
    if (!state.found) {
        return { effect: 'none', matchedRule: null, matchedDimension: null, reason: 'No enterprise policy configured.', sourcePath: null };
    }
    if (state.error || !state.policy) {
        return {
            effect: 'deny',
            matchedRule: null,
            matchedDimension: 'policy_error',
            reason: state.error || 'Enterprise policy file failed to load (fail-closed).',
            sourcePath: state.sourcePath
        };
    }
    const policy = state.policy;
    const toolRaw = String(input.tool || '').trim();
    const toolNorm = canonicalTool(toolRaw);
    const toolCandidates = toolRaw && toolRaw !== toolNorm ? [toolRaw, toolNorm] : [toolNorm];
    const args = input.args && typeof input.args === 'object' ? input.args : {};
    const mcpServer = extractMcpServer(toolRaw);
    const mcpCandidates = mcpServer ? [mcpServer] : [];
    const commandCandidates = extractCommandStrings(toolNorm, args);
    const pathCandidates = extractPathCandidates(args, input.workspaceRoot);
    const domainCandidates = extractDomains(args);
    const checks = [
        { dim: 'tools', bucket: policy.tools, candidates: toolCandidates, caseInsensitive: true },
        { dim: 'mcpServers', bucket: policy.mcpServers, candidates: mcpCandidates, caseInsensitive: true },
        { dim: 'commands', bucket: policy.commands, candidates: commandCandidates, caseInsensitive: false },
        { dim: 'paths', bucket: policy.paths, candidates: pathCandidates, caseInsensitive: process.platform === 'win32' },
        { dim: 'domains', bucket: policy.domains, candidates: domainCandidates, caseInsensitive: true }
    ];
    // Pass 1: explicit DENY always wins
    for (const check of checks) {
        if (check.candidates.length === 0)
            continue;
        const hit = firstMatch(check.bucket.deny, check.candidates, check.caseInsensitive);
        if (hit) {
            return {
                effect: 'deny',
                matchedRule: hit,
                matchedDimension: check.dim,
                reason: `Blocked by enterprise policy (${check.dim}.deny matched "${safeDisplay(hit)}").`,
                sourcePath: state.sourcePath
            };
        }
    }
    // Pass 2: explicit ASK overrides allow and autonomous modes
    for (const check of checks) {
        if (check.candidates.length === 0)
            continue;
        const hit = firstMatch(check.bucket.ask, check.candidates, check.caseInsensitive);
        if (hit) {
            return {
                effect: 'ask',
                matchedRule: hit,
                matchedDimension: check.dim,
                reason: `Approval required by enterprise policy (${check.dim}.ask matched "${safeDisplay(hit)}").`,
                sourcePath: state.sourcePath
            };
        }
    }
    // Pass 3: explicit ALLOW
    for (const check of checks) {
        if (check.candidates.length === 0)
            continue;
        const hit = firstMatch(check.bucket.allow, check.candidates, check.caseInsensitive);
        if (hit) {
            return {
                effect: 'allow',
                matchedRule: hit,
                matchedDimension: check.dim,
                reason: `Allowed by enterprise policy (${check.dim}.allow matched "${safeDisplay(hit)}").`,
                sourcePath: state.sourcePath
            };
        }
    }
    if (policy.defaultEffect) {
        return {
            effect: policy.defaultEffect,
            matchedRule: '*',
            matchedDimension: 'default',
            reason: `Enterprise policy defaultEffect="${policy.defaultEffect}" applied.`,
            sourcePath: state.sourcePath
        };
    }
    return {
        effect: 'none',
        matchedRule: null,
        matchedDimension: null,
        reason: 'No matching enterprise policy rule.',
        sourcePath: state.sourcePath
    };
}
export function formatEnterprisePolicyReport(workspaceRoot = process.cwd(), env = process.env) {
    const loaded = loadEnterprisePolicy(workspaceRoot, env);
    if (!loaded.found) {
        return {
            ok: true,
            text: [
                'Enterprise policy',
                '  Status : not configured',
                `  Lookup : ${discoverPolicyPaths(workspaceRoot, env).map((p) => safeDisplay(p)).join(', ')}`,
                '',
                'Create causyne.policy.json in your workspace (or ~/.causyne/policy.json) with',
                'version: 1 and allow/ask/deny rules for tools, commands, paths, domains, and mcpServers.'
            ].join('\n')
        };
    }
    if (loaded.error || !loaded.policy) {
        return {
            ok: false,
            text: [
                'Enterprise policy',
                '  Status : INVALID (fail-closed)',
                `  Source : ${safeDisplay(loaded.sourcePath || '')}`,
                `  Error  : ${safeDisplay(loaded.error || 'Unknown error')}`
            ].join('\n')
        };
    }
    const p = loaded.policy;
    const count = (b) => `allow:${b.allow.length} ask:${b.ask.length} deny:${b.deny.length}`;
    return {
        ok: true,
        text: [
            'Enterprise policy',
            '  Status        : active',
            `  Source        : ${safeDisplay(loaded.sourcePath || '')}`,
            `  Default effect: ${p.defaultEffect ?? '(none — falls through to autonomy mode)'}`,
            `  tools         : ${count(p.tools)}`,
            `  commands      : ${count(p.commands)}`,
            `  paths         : ${count(p.paths)}`,
            `  domains       : ${count(p.domains)}`,
            `  mcpServers    : ${count(p.mcpServers)}`
        ].join('\n')
    };
}
