/**
 * Causyne Agent — Zero-API-Key & Free-Tier Provider Discovery
 *
 * Discovers every zero-spend runtime available on the user's machine so users
 * without paid API keys can run Causyne Agent immediately:
 *   1. Local Ollama (offline $0 — inspects running /api/ps, /api/tags, and local disk manifests)
 *   2. OpenRouter Free (`openrouter/free` — $0 cloud tier with OPENROUTER_API_KEY)
 *   3. Free local/ACP peers (`antigravity`, `acp/opencode`, `acp/cursor`, `acp/hermes`)
 *   4. Free-tier BYOK keys already set in the environment (`GEMINI_API_KEY`, `GROQ_API_KEY`,
 *      `CEREBRAS_API_KEY`, `MISTRAL_API_KEY`)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ollamaOriginUrl } from './providers/ollama.js';
import { readBoundedResponseText } from './providers/byokHttp.js';
import { resolveProviderApiKey } from './config.js';
const PREFERRED_OLLAMA_PREFIXES = [
    'qwen2.5-coder',
    'qwen3-coder',
    'qwen3',
    'qwen2.5',
    'deepseek-r1',
    'deepseek-coder',
    'llama3.3',
    'llama3.2',
    'llama3.1',
    'codestral',
    'devstral',
    'mistral',
    'gemma3',
    'gemma2',
    'phi4',
    'gpt-oss'
];
const MAX_MANIFEST_ENTRIES = 128;
function scoreOllamaModel(rawName) {
    const lower = rawName.trim().toLowerCase();
    for (let i = 0; i < PREFERRED_OLLAMA_PREFIXES.length; i++) {
        const prefix = PREFERRED_OLLAMA_PREFIXES[i];
        if (lower === prefix || lower.startsWith(`${prefix}:`) || lower.startsWith(`${prefix}-`)) {
            return PREFERRED_OLLAMA_PREFIXES.length - i;
        }
    }
    return 0;
}
function normalizeOllamaTagName(name, tag) {
    return tag === 'latest' ? name : `${name}:${tag}`;
}
/**
 * Inspects Ollama's local manifest directory without performing any network I/O
 * so Causyne can select an actually installed local model on first launch.
 */
export function listLocalOllamaDiskModels(ollamaModelsDir, env = process.env) {
    const envDir = typeof env.OLLAMA_MODELS === 'string' && env.OLLAMA_MODELS.trim()
        ? env.OLLAMA_MODELS.trim()
        : '';
    const home = os.homedir();
    const baseDir = ollamaModelsDir?.trim()
        || envDir
        || (home ? path.join(home, '.ollama', 'models') : '');
    if (!baseDir || baseDir.includes('\0'))
        return [];
    const libraryRoot = path.join(baseDir, 'manifests', 'registry.ollama.ai', 'library');
    let repoEntries;
    try {
        repoEntries = fs.readdirSync(libraryRoot, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const found = [];
    for (const repo of repoEntries) {
        if (found.length >= MAX_MANIFEST_ENTRIES)
            break;
        if (!repo.isDirectory() || repo.name.startsWith('.'))
            continue;
        const repoPath = path.join(libraryRoot, repo.name);
        let tagEntries;
        try {
            tagEntries = fs.readdirSync(repoPath, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const tag of tagEntries) {
            if (found.length >= MAX_MANIFEST_ENTRIES)
                break;
            if ((!tag.isFile() && !tag.isSymbolicLink()) || tag.name.startsWith('.'))
                continue;
            found.push(normalizeOllamaTagName(repo.name, tag.name));
        }
    }
    return [...new Set(found)].sort((a, b) => {
        const diff = scoreOllamaModel(b) - scoreOllamaModel(a);
        return diff !== 0 ? diff : a.localeCompare(b);
    });
}
/**
 * Picks the highest-capability tool/coding local Ollama model from a candidate list.
 */
export function pickPreferredLocalOllamaModel(models) {
    const cleaned = models
        .map((m) => String(m || '').trim())
        .filter(Boolean);
    if (cleaned.length === 0)
        return '';
    let best = cleaned[0];
    let bestScore = scoreOllamaModel(best);
    for (let i = 1; i < cleaned.length; i++) {
        const candidate = cleaned[i];
        const score = scoreOllamaModel(candidate);
        if (score > bestScore) {
            best = candidate;
            bestScore = score;
        }
    }
    return best;
}
function normalizeModelId(raw) {
    return raw.endsWith(':latest') ? raw.slice(0, -':latest'.length) : raw;
}
function extractOllamaNames(payload) {
    if (!payload || typeof payload !== 'object')
        return [];
    const rawModels = payload.models;
    if (!Array.isArray(rawModels))
        return [];
    const out = [];
    for (const entry of rawModels) {
        if (!entry || typeof entry !== 'object')
            continue;
        const rec = entry;
        const rawName = typeof rec.name === 'string' && rec.name.trim()
            ? rec.name.trim()
            : (typeof rec.model === 'string' && rec.model.trim() ? rec.model.trim() : '');
        if (rawName)
            out.push(normalizeModelId(rawName));
    }
    return [...new Set(out)];
}
/**
 * Bounded live probe against local Ollama `/api/ps` (warm models) and `/api/tags`.
 * Never throws; returns `{ reachable: false, running: [], installed: [] }` when offline.
 */
export async function probeOllamaReachableModels(baseUrl, timeoutMs = 1500) {
    const origin = ollamaOriginUrl(baseUrl || 'http://127.0.0.1:11434');
    const boundedTimeout = Math.max(250, Math.min(8000, Math.floor(timeoutMs)));
    const fetchJson = async (endpoint) => {
        try {
            const res = await fetch(endpoint, {
                method: 'GET',
                redirect: 'error',
                signal: AbortSignal.timeout(boundedTimeout)
            });
            if (!res.ok)
                return { ok: false, data: null };
            const text = await readBoundedResponseText(res, 1024 * 1024, { truncate: false, label: 'Ollama' });
            return { ok: true, data: JSON.parse(text) };
        }
        catch {
            return { ok: false, data: null };
        }
    };
    const [psRes, tagsRes] = await Promise.all([
        fetchJson(`${origin}/api/ps`),
        fetchJson(`${origin}/api/tags`)
    ]);
    if (!psRes.ok && !tagsRes.ok) {
        return { reachable: false, running: [], installed: [] };
    }
    return {
        reachable: true,
        running: extractOllamaNames(psRes.data),
        installed: extractOllamaNames(tagsRes.data)
    };
}
function hasExecutableOnPath(binaryName, env) {
    const envPath = env.PATH || env.Path || '';
    const delimiter = process.platform === 'win32' ? ';' : ':';
    const home = os.homedir();
    const fallbackDirs = [
        ...(home && path.isAbsolute(home) ? [
            path.join(home, '.local', 'bin'),
            path.join(home, '.antigravity', 'antigravity', 'bin'),
            path.join(home, '.gemini', 'antigravity-ide', 'bin'),
            path.join(home, '.opencode', 'bin')
        ] : []),
        '/Applications/Antigravity.app/Contents/Resources/app/bin',
        '/Applications/Antigravity IDE.app/Contents/Resources/app/bin'
    ];
    const dirs = [...envPath.split(delimiter), ...fallbackDirs];
    const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
    for (const rawDir of dirs) {
        const dir = rawDir.trim();
        if (!dir || !path.isAbsolute(dir))
            continue;
        for (const ext of exts) {
            const full = path.join(dir, `${binaryName}${ext}`);
            try {
                if (fs.statSync(full).isFile()) {
                    if (process.platform !== 'win32')
                        fs.accessSync(full, fs.constants.X_OK);
                    return true;
                }
            }
            catch {
                continue;
            }
        }
    }
    return false;
}
/**
 * Surveys all zero-spend providers available on this host without making
 * paid API calls or stripping any connected peer capabilities.
 */
export async function detectZeroCostProviders(options = {}) {
    const env = options.env ?? process.env;
    const config = options.config ?? null;
    const results = [];
    // 1. Local Ollama ($0 offline)
    const ollamaInstalledOnPath = hasExecutableOnPath('ollama', env);
    const diskModels = listLocalOllamaDiskModels(options.ollamaModelsDir, env);
    const probed = options.probeOllama === true
        ? await probeOllamaReachableModels(options.ollamaBaseUrl ?? config?.ollamaBaseUrl, options.timeoutMs)
        : { reachable: false, running: [], installed: [] };
    const allOllamaModels = [...new Set([...probed.running, ...probed.installed, ...diskModels])];
    const preferredOllama = probed.running[0] || pickPreferredLocalOllamaModel(allOllamaModels);
    if (probed.reachable && preferredOllama) {
        results.push({
            id: 'ollama',
            label: 'Ollama (Local Offline)',
            provider: 'ollama',
            model: preferredOllama,
            costTier: 'offline_free',
            readiness: 'ready',
            reason: probed.running.length > 0
                ? `Ollama daemon reachable with warm model "${preferredOllama}" (${allOllamaModels.length} local model(s)).`
                : `Ollama daemon reachable with ${allOllamaModels.length} local model(s); selected "${preferredOllama}".`,
            models: allOllamaModels
        });
    }
    else if (ollamaInstalledOnPath && preferredOllama) {
        results.push({
            id: 'ollama',
            label: 'Ollama (Local Offline)',
            provider: 'ollama',
            model: preferredOllama,
            costTier: 'offline_free',
            readiness: 'ready',
            reason: `Ollama binary and local model "${preferredOllama}" found on disk (start \`ollama serve\` if not running).`,
            models: allOllamaModels
        });
    }
    else if (ollamaInstalledOnPath || probed.reachable) {
        results.push({
            id: 'ollama',
            label: 'Ollama (Local Offline)',
            provider: 'ollama',
            model: 'qwen2.5-coder',
            costTier: 'offline_free',
            readiness: 'needs_model',
            reason: 'Ollama is installed, but no local models are pulled yet. Run `ollama pull qwen2.5-coder`.'
        });
    }
    // 2. OpenRouter Free ($0 cloud router — openrouter/free)
    const orKey = (typeof env.OPENROUTER_API_KEY === 'string' && env.OPENROUTER_API_KEY.trim())
        || resolveProviderApiKey(config, 'openrouter-free');
    results.push({
        id: 'openrouter-free',
        label: 'OpenRouter Free',
        provider: 'openrouter-free',
        model: 'openrouter/free',
        costTier: 'cloud_free',
        readiness: orKey ? 'ready' : 'needs_free_key',
        reason: orKey
            ? 'OpenRouter key configured; locked to zero-cost `:free` routes.'
            : 'Free account key available at openrouter.ai/keys (no credit card required for `:free` models).'
    });
    // 3. Free local / ACP peers
    const hasAgy = hasExecutableOnPath('agy', env) || hasExecutableOnPath('antigravity', env);
    if (hasAgy) {
        results.push({
            id: 'antigravity',
            label: 'Google Antigravity CLI',
            provider: 'antigravity',
            model: 'Gemini 3.8 Flash (Low)',
            costTier: 'peer_free',
            readiness: 'ready',
            reason: 'Antigravity CLI detected locally.'
        });
    }
    if (hasExecutableOnPath('opencode', env)) {
        results.push({
            id: 'acp/opencode',
            label: 'OpenCode (ACP Free Peer)',
            provider: 'acp/opencode',
            model: 'opencode/big-pickle',
            costTier: 'peer_free',
            readiness: 'ready',
            reason: 'OpenCode CLI detected locally with built-in free models.'
        });
    }
    if (hasExecutableOnPath('cursor-agent', env) || hasExecutableOnPath('cursor', env)) {
        results.push({
            id: 'acp/cursor',
            label: 'Cursor (ACP Peer)',
            provider: 'acp/cursor',
            model: '',
            costTier: 'peer_free',
            readiness: 'ready',
            reason: 'Cursor CLI detected locally.'
        });
    }
    // 4. Free-tier BYOK keys already exported in environment
    const geminiKey = (typeof env.GEMINI_API_KEY === 'string' && env.GEMINI_API_KEY.trim())
        || (typeof env.GOOGLE_API_KEY === 'string' && env.GOOGLE_API_KEY.trim())
        || resolveProviderApiKey(config, 'gemini');
    if (geminiKey) {
        results.push({
            id: 'gemini',
            label: 'Google AI Studio (Gemini Free Tier)',
            provider: 'gemini',
            model: 'gemini-2.5-flash',
            costTier: 'cloud_free',
            readiness: 'ready',
            reason: 'GEMINI_API_KEY configured (supports Google AI Studio free tier).'
        });
    }
    return results;
}
/**
 * Selects the highest-priority ready zero-cost provider from a discovery list.
 */
export function pickBestZeroCostProvider(candidates) {
    const ready = candidates.filter((c) => c.readiness === 'ready');
    if (ready.length === 0)
        return null;
    const order = {
        'openrouter-free': 1,
        'ollama': 2,
        'antigravity': 3,
        'acp/opencode': 4,
        'gemini': 5,
        'acp/cursor': 6
    };
    return [...ready].sort((a, b) => (order[a.id] ?? 99) - (order[b.id] ?? 99))[0] ?? null;
}
