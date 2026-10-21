// Sovereign Dynamic Model Architecture & Live Discovery
//
// WHY THIS EXISTS:
// AI providers release and update models continuously. Hardcoded static
// catalogues freeze models at build time. This module gives Causyne a dual-layer
// model architecture:
//   1. Curated baseline: Instant offline availability with zero latency and verified pricing/capability tiers.
//   2. Dynamic discovery: Live discovery via provider APIs (Ollama, OpenAI, Gemini, Anthropic, DeepSeek, etc.)
//      with resilient local caching in ~/.causyne/models_cache.json.
//
// ZERO-MALWARE: Pure TypeScript/ESM. Strictly respects timeouts, no secret leakage, no unprompted background calls.
import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from './utils/paths.js';
import { MODEL_CATALOGUE, DEFAULT_MODEL_BY_PROVIDER } from './modelCatalogue.js';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const REQUEST_TIMEOUT_MS = 3500; // Fast timeout to never block user interaction
export function cacheFilePath() {
    return path.join(causyneHome(), 'models_cache.json');
}
export function normalizeProviderKey(provider) {
    const p = (provider || '').toLowerCase().trim();
    if (p === 'dashscope' || p === 'dashscope-byok' || p === 'alibaba')
        return 'dashscope-byok';
    if (p === 'ollama')
        return 'ollama';
    if (p === 'openai')
        return 'openai';
    if (p === 'anthropic' || p === 'claude')
        return 'anthropic';
    if (p === 'gemini' || p === 'google')
        return 'gemini';
    if (p === 'deepseek')
        return 'deepseek';
    if (p === 'xai' || p === 'grok')
        return 'xai';
    if (p === 'moonshot' || p === 'kimi')
        return 'moonshot';
    if (p === 'muse' || p === 'meta')
        return 'muse';
    if (p === 'openai-compatible' || p === 'custom')
        return 'openai-compatible';
    return p;
}
/** Get the static curated models for a provider id. */
export function getCuratedModels(provider) {
    const norm = normalizeProviderKey(provider);
    const mapping = {
        'deepseek': 'DeepSeek',
        'qwen': 'Qwen',
        'dashscope-byok': 'Alibaba (DashScope)',
        'dashscope': 'Alibaba (DashScope)',
        'anthropic': 'Anthropic',
        'openai': 'OpenAI',
        'gemini': 'Gemini',
        'muse': 'Meta (Muse)',
        'ollama': 'Ollama (Local)',
        'moonshot': 'Moonshot (Kimi)',
        'xai': 'xAI (Grok)'
    };
    const key = mapping[norm];
    if (key && MODEL_CATALOGUE[key]) {
        return [...MODEL_CATALOGUE[key]];
    }
    return [];
}
/** Read cache safely from ~/.causyne/models_cache.json */
export function readModelCache() {
    try {
        const file = cacheFilePath();
        if (!fs.existsSync(file))
            return null;
        const content = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(content);
        if (parsed && parsed.version === 1 && typeof parsed.providers === 'object') {
            return parsed;
        }
    }
    catch {
        // Graceful fallback on corrupt or inaccessible cache
    }
    return null;
}
/** Save cache safely to ~/.causyne/models_cache.json */
export function writeModelCache(cache) {
    try {
        const dir = causyneHome();
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
        const file = cacheFilePath();
        fs.writeFileSync(file, JSON.stringify(cache, null, 2), { mode: 0o600 });
    }
    catch {
        // Cache failures must never crash the CLI
    }
}
/** Get cached models for a provider if not expired */
export function getCachedModels(provider) {
    const cache = readModelCache();
    if (!cache)
        return null;
    const norm = normalizeProviderKey(provider);
    const entry = cache.providers[norm];
    if (!entry)
        return null;
    if (Date.now() - entry.timestamp > CACHE_TTL_MS)
        return null;
    return entry.models;
}
/** Save models for a provider into the local cache */
export function saveCachedModels(provider, models) {
    const norm = normalizeProviderKey(provider);
    const cache = readModelCache() || {
        version: 1,
        updatedAt: new Date().toISOString(),
        providers: {}
    };
    cache.providers[norm] = {
        timestamp: Date.now(),
        models: [...new Set(models)]
    };
    cache.updatedAt = new Date().toISOString();
    writeModelCache(cache);
}
/** Live query provider API to discover available models */
export async function fetchLiveModels(provider, config = {}) {
    const norm = normalizeProviderKey(provider);
    const { apiKey, baseUrl } = config;
    try {
        if (norm === 'ollama') {
            const host = (baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
            const res = await fetch(`${host}/api/tags`, {
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            });
            if (!res.ok)
                return [];
            const data = await res.json();
            if (Array.isArray(data.models)) {
                return data.models
                    .map((m) => (m.name || '').replace(/:latest$/, ''))
                    .filter(Boolean);
            }
        }
        if (norm === 'openai') {
            if (!apiKey)
                return [];
            const host = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
            const res = await fetch(`${host}/models`, {
                headers: { Authorization: `Bearer ${apiKey}` },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            });
            if (!res.ok)
                return [];
            const data = await res.json();
            if (Array.isArray(data.data)) {
                return data.data
                    .map((m) => m.id || '')
                    .filter((id) => /^(gpt|o1|o3|chatgpt)/i.test(id))
                    .sort();
            }
        }
        if (norm === 'gemini') {
            if (!apiKey)
                return [];
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`, {
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            });
            if (!res.ok)
                return [];
            const data = await res.json();
            if (Array.isArray(data.models)) {
                return data.models
                    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
                    .map((m) => (m.name || '').replace(/^models\//, ''))
                    .filter(Boolean)
                    .sort();
            }
        }
        if (norm === 'anthropic') {
            if (!apiKey)
                return [];
            const res = await fetch('https://api.anthropic.com/v1/models', {
                headers: {
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            });
            if (!res.ok)
                return [];
            const data = await res.json();
            if (Array.isArray(data.data)) {
                return data.data
                    .map((m) => m.id || '')
                    .filter(Boolean)
                    .sort();
            }
        }
        if (norm === 'deepseek') {
            if (!apiKey)
                return [];
            const res = await fetch('https://api.deepseek.com/models', {
                headers: { Authorization: `Bearer ${apiKey}` },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            });
            if (!res.ok)
                return [];
            const data = await res.json();
            if (Array.isArray(data.data)) {
                return data.data.map((m) => m.id || '').filter(Boolean).sort();
            }
        }
        if (norm === 'openai-compatible') {
            if (!baseUrl)
                return [];
            const host = baseUrl.replace(/\/+$/, '');
            const headers = {};
            if (apiKey)
                headers['Authorization'] = `Bearer ${apiKey}`;
            const res = await fetch(`${host}/models`, {
                headers,
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            });
            if (!res.ok)
                return [];
            const data = await res.json();
            if (Array.isArray(data.data)) {
                return data.data.map((m) => m.id || '').filter(Boolean).sort();
            }
        }
    }
    catch {
        // Network errors or timeouts silently fall back
    }
    return [];
}
/**
 * Resolve available models using dual-layer architecture:
 * 1. Checks live query if forceRefresh is true.
 * 2. Checks local cache if available and fresh.
 * 3. Falls back to static curated catalogue merged with any cached items.
 */
export async function resolveAvailableModels(provider, config = {}, forceRefresh = false) {
    const norm = normalizeProviderKey(provider);
    const curated = getCuratedModels(norm);
    if (forceRefresh) {
        const live = await fetchLiveModels(norm, config);
        if (live.length > 0) {
            const combined = [...new Set([...live, ...curated])];
            saveCachedModels(norm, combined);
            return { models: combined, source: 'live' };
        }
    }
    const cached = getCachedModels(norm);
    if (cached && cached.length > 0) {
        const combined = [...new Set([...cached, ...curated])];
        return { models: combined, source: 'cache' };
    }
    // Attempt lazy background discovery if credentials exist
    if (config.apiKey || norm === 'ollama') {
        const live = await fetchLiveModels(norm, config);
        if (live.length > 0) {
            const combined = [...new Set([...live, ...curated])];
            saveCachedModels(norm, combined);
            return { models: combined, source: 'live' };
        }
    }
    return { models: curated, source: 'catalogue' };
}
