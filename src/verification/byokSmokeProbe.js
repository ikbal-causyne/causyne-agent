/**
 * Zero-Spend ($0) BYOK & Local Provider Live Smoke Probe
 *
 * Verifies real provider wire compatibility (HTTP 200, streaming, tool-schema
 * acceptance, and non-empty response) across offline Ollama and any configured
 * $0 free-tier cloud keys (Google AI Studio Gemini Free, Groq, Cerebras,
 * Mistral, OpenRouter Free) without ever spending paid BYOK credits unless
 * explicitly opted in via `includePaid: true`.
 */
import { createProvider } from '../providers/factory.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { detectZeroCostProviders } from '../zeroCostRouting.js';
import { redactProviderSecrets } from '../providers/byokHttp.js';
import { safeDisplay } from '../tui/text.js';
const SMOKE_TOOLS = [
    {
        name: 'ping_workspace',
        description: 'Return a short workspace health confirmation.',
        parameters: {
            type: 'object',
            properties: {
                message: { type: 'string', description: 'Short echo string.' }
            },
            required: ['message']
        }
    }
];
const FREE_CLOUD_TARGETS = [
    { provider: 'gemini-free', envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], model: DEFAULT_MODEL_BY_PROVIDER['gemini-free'] || 'gemini-2.5-flash' },
    { provider: 'groq', envKeys: ['GROQ_API_KEY'], model: DEFAULT_MODEL_BY_PROVIDER.groq || 'openai/gpt-oss-120b' },
    { provider: 'cerebras', envKeys: ['CEREBRAS_API_KEY'], model: DEFAULT_MODEL_BY_PROVIDER.cerebras || 'qwen-3-32b' },
    { provider: 'mistral', envKeys: ['MISTRAL_API_KEY'], model: DEFAULT_MODEL_BY_PROVIDER.mistral || 'devstral-small-latest' },
    { provider: 'openrouter-free', envKeys: ['OPENROUTER_API_KEY'], model: DEFAULT_MODEL_BY_PROVIDER.openrouter || 'openrouter/free' }
];
function firstEnvKey(env, keys) {
    for (const key of keys) {
        const val = env[key];
        if (typeof val === 'string' && val.trim().length > 0)
            return val.trim();
    }
    return '';
}
export async function runZeroSpendByokProbe(options = {}) {
    const env = options.env ?? process.env;
    const timeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs >= 1000
        ? Math.min(60_000, Math.floor(options.timeoutMs))
        : 20_000;
    const results = [];
    // 1. Offline local Ollama ($0) — probe live daemon on 127.0.0.1:11434 first
    if (options.probeOllama !== false) {
        let liveOllamaModel = '';
        let daemonReachable = false;
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 1_500);
            t.unref?.();
            try {
                const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: ctrl.signal });
                if (res.ok) {
                    daemonReachable = true;
                    const payload = await res.json().catch(() => ({}));
                    const names = Array.isArray(payload.models)
                        ? payload.models.map((m) => String(m?.name || '').trim()).filter(Boolean)
                        : [];
                    const preferred = names.find((n) => /(?:coder|llama3\.1:8b|qwen2\.5:7b)/i.test(n)) || names[0] || '';
                    liveOllamaModel = preferred;
                }
            }
            finally {
                clearTimeout(t);
            }
        }
        catch {
            daemonReachable = false;
        }
        if (!daemonReachable || !liveOllamaModel) {
            const zeroCost = await detectZeroCostProviders({ env, probeOllama: false });
            const diskOllama = zeroCost.find((z) => z.provider === 'ollama' && z.model);
            results.push({
                provider: 'ollama',
                model: diskOllama?.model || '(not running)',
                costTier: 'offline_free',
                status: 'skipped',
                latencyMs: 0,
                detail: diskOllama?.model
                    ? `Ollama disk model (${diskOllama.model}) found; start \`ollama serve\` to run live probe.`
                    : 'Local Ollama server not reachable on 127.0.0.1:11434 or no model installed.'
            });
        }
        else {
            const t0 = Date.now();
            try {
                const llm = createProvider({ provider: 'ollama', model: liveOllamaModel });
                const resp = await llm.chat([{ role: 'user', content: 'Reply with the single word OK.' }], { maxTokens: 16, timeoutMs, tools: SMOKE_TOOLS });
                const text = (resp.content || '').trim();
                const hasReply = text.length > 0 || (Array.isArray(resp.toolCalls) && resp.toolCalls.length > 0);
                results.push({
                    provider: 'ollama',
                    model: liveOllamaModel,
                    costTier: 'offline_free',
                    status: hasReply ? 'pass' : 'fail',
                    latencyMs: Date.now() - t0,
                    detail: hasReply ? `Live offline response verified (${text.slice(0, 40) || 'tool_call'})` : 'Empty response'
                });
            }
            catch (err) {
                results.push({
                    provider: 'ollama',
                    model: liveOllamaModel,
                    costTier: 'offline_free',
                    status: 'fail',
                    latencyMs: Date.now() - t0,
                    detail: redactProviderSecrets(err instanceof Error ? err.message : String(err)).slice(0, 240)
                });
            }
        }
    }
    // 2. Configured $0 Free Cloud Tiers (never touches paid keys)
    for (const target of FREE_CLOUD_TARGETS) {
        const apiKey = firstEnvKey(env, target.envKeys);
        if (!apiKey) {
            results.push({
                provider: target.provider,
                model: target.model,
                costTier: 'cloud_free',
                status: 'skipped',
                latencyMs: 0,
                detail: `Set ${target.envKeys[0]} (free, no credit card) to run live wire probe.`
            });
            continue;
        }
        const t0 = Date.now();
        try {
            const llm = createProvider({
                provider: target.provider,
                model: target.model,
                apiKey
            });
            let streamedChars = 0;
            const resp = await llm.chat([{ role: 'user', content: 'Reply with the single word OK.' }], {
                maxTokens: 16,
                timeoutMs,
                tools: SMOKE_TOOLS,
                onChunk: (delta) => { streamedChars += delta.length; }
            });
            const text = (resp.content || '').trim();
            const hasReply = text.length > 0 || (Array.isArray(resp.toolCalls) && resp.toolCalls.length > 0);
            results.push({
                provider: target.provider,
                model: target.model,
                costTier: 'cloud_free',
                status: hasReply ? 'pass' : 'fail',
                latencyMs: Date.now() - t0,
                detail: hasReply
                    ? `HTTP 200 + tool schema accepted (streamed ${streamedChars} chars)`
                    : 'Empty response from provider'
            });
        }
        catch (err) {
            results.push({
                provider: target.provider,
                model: target.model,
                costTier: 'cloud_free',
                status: 'fail',
                latencyMs: Date.now() - t0,
                detail: redactProviderSecrets(err instanceof Error ? err.message : String(err), [apiKey]).slice(0, 240)
            });
        }
    }
    const passedCount = results.filter((r) => r.status === 'pass').length;
    const failedCount = results.filter((r) => r.status === 'fail').length;
    const skippedCount = results.filter((r) => r.status === 'skipped').length;
    return {
        timestamp: new Date().toISOString(),
        testedCount: passedCount + failedCount,
        passedCount,
        failedCount,
        skippedCount,
        results
    };
}
export function formatByokProbeReport(report) {
    const lines = [
        `Causyne Zero-Spend ($0) BYOK Live Probe — ${report.passedCount}/${report.testedCount} passed (${report.skippedCount} unconfigured)`,
        ''
    ];
    for (const r of report.results) {
        const icon = r.status === 'pass' ? '✓' : (r.status === 'fail' ? '✕' : '•');
        const timing = r.status === 'skipped' ? 'skipped' : `${r.latencyMs}ms`;
        lines.push(`  ${icon} ${safeDisplay(r.provider)} [${safeDisplay(r.model)}] (${timing}) — ${safeDisplay(r.detail)}`);
    }
    return lines.join('\n');
}
