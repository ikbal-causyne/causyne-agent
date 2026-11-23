/**
 * Causyne Agent — Strict Zero-Spend Automatic Failover Router
 *
 * When a zero-cost route (e.g. OpenRouter Free hitting HTTP 429, Groq Free
 * exhausting RPM, or an offline network drop) exhausts its retry ceiling,
 * this router selects the next verified `$0` runtime on the user's machine:
 *   cloud free tier -> alternative cloud free tier -> local Ollama -> free ACP peer
 *
 * Hard safety invariants:
 *   - NEVER switches to a paid BYOK provider (OpenAI, Anthropic, DeepSeek, etc.).
 *   - NEVER strips or degrades ACP peer capabilities (`ACP_CAPABILITY_POLICY.md`).
 *   - NEVER cycles back to an already-exhausted provider within the same task.
 *   - NEVER carries an API key from one provider onto another provider.
 */

import { resolveProviderApiKey, type CausyneConfig } from './config.js';
import {
  detectZeroCostProviders,
  type DetectZeroCostOptions,
  type ZeroCostProviderStatus
} from './zeroCostRouting.js';

export interface ZeroCostFailoverRoute {
  provider: string;
  model: string;
  apiKey: string;
  label: string;
  costTier: 'offline_free' | 'cloud_free' | 'peer_free';
  reason: string;
}

export interface SelectZeroCostFailoverOptions {
  currentProvider: string;
  currentModel?: string | undefined;
  triedProviders?: ReadonlySet<string> | readonly string[] | undefined;
  config?: CausyneConfig | null | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  candidates?: readonly ZeroCostProviderStatus[] | undefined;
  detectOptions?: DetectZeroCostOptions | undefined;
  reason?: 'rate_limit' | 'network_error' | 'quota' | undefined;
}

const ZERO_COST_PROVIDER_IDS = new Set([
  'ollama',
  'openrouter-free',
  'groq',
  'groq-free',
  'cerebras',
  'cerebras-free',
  'mistral',
  'mistral-free',
  'gemini-free',
  'antigravity',
  'acp/opencode',
  'acp/cursor',
  'acp/hermes'
]);

const FAILOVER_PRIORITY: Record<string, number> = {
  'groq': 1,
  'cerebras': 2,
  'mistral': 3,
  'gemini-free': 4,
  'gemini': 4,
  'openrouter-free': 5,
  'ollama': 6,
  'antigravity': 7,
  'acp/opencode': 8,
  'acp/cursor': 9
};

export function normalizeZeroCostId(provider: unknown): string {
  const raw = String(provider || '').trim().toLowerCase();
  if (raw === 'openrouter') return 'openrouter-free';
  if (raw === 'groq-free') return 'groq';
  if (raw === 'cerebras-free') return 'cerebras';
  if (raw === 'mistral-free' || raw === 'codestral') return 'mistral';
  if (raw === 'gemini') return 'gemini-free';
  return raw;
}

/**
 * True strictly when the active `(provider, model)` pair is a zero-spend route.
 * Paid BYOK routes (OpenAI, Anthropic, DeepSeek, paid OpenRouter, etc.) return false.
 */
export function isZeroCostFailoverEligible(provider: unknown, model?: unknown): boolean {
  const p = String(provider || '').trim().toLowerCase();
  const m = String(model || '').trim().toLowerCase();
  if (!p) return false;
  if (ZERO_COST_PROVIDER_IDS.has(p)) return true;
  if (p === 'openrouter' && (m === '' || m === 'openrouter/free' || m.endsWith(':free'))) return true;
  return false;
}

function resolveKeyForFailoverCandidate(
  candidate: ZeroCostProviderStatus,
  config: CausyneConfig | null | undefined,
  env: NodeJS.ProcessEnv
): string {
  const id = normalizeZeroCostId(candidate.provider);
  if (id === 'ollama' || id === 'antigravity' || id.startsWith('acp/')) return '';
  if (id === 'openrouter-free') {
    return (typeof env.OPENROUTER_API_KEY === 'string' && env.OPENROUTER_API_KEY.trim())
      || resolveProviderApiKey(config, 'openrouter-free');
  }
  if (id === 'groq') {
    return (typeof env.GROQ_API_KEY === 'string' && env.GROQ_API_KEY.trim())
      || resolveProviderApiKey(config, 'groq');
  }
  if (id === 'cerebras') {
    return (typeof env.CEREBRAS_API_KEY === 'string' && env.CEREBRAS_API_KEY.trim())
      || resolveProviderApiKey(config, 'cerebras');
  }
  if (id === 'mistral') {
    return (typeof env.MISTRAL_API_KEY === 'string' && env.MISTRAL_API_KEY.trim())
      || resolveProviderApiKey(config, 'mistral');
  }
  if (id === 'gemini-free') {
    return (typeof env.GEMINI_API_KEY === 'string' && env.GEMINI_API_KEY.trim())
      || (typeof env.GOOGLE_API_KEY === 'string' && env.GOOGLE_API_KEY.trim())
      || resolveProviderApiKey(config, 'gemini-free');
  }
  return '';
}

/**
 * Picks the next ready, untried zero-spend provider for automatic failover.
 * Prefers offline Ollama immediately on network failures so offline work continues
 * without waiting on unreachable cloud endpoints.
 */
export async function selectNextZeroCostRoute(
  options: SelectZeroCostFailoverOptions
): Promise<ZeroCostFailoverRoute | null> {
  const env = options.env ?? process.env;
  if (env.CAUSYNE_ZERO_COST_FAILOVER === '0' || env.CAUSYNE_ZERO_COST_FAILOVER === 'false') {
    return null;
  }
  if (options.config && options.config.zeroCostFailover === false) {
    return null;
  }
  if (!isZeroCostFailoverEligible(options.currentProvider, options.currentModel)) {
    return null;
  }

  const tried = new Set<string>();
  tried.add(normalizeZeroCostId(options.currentProvider));
  if (options.triedProviders) {
    for (const item of options.triedProviders) {
      tried.add(normalizeZeroCostId(item));
    }
  }

  const discovered = options.candidates
    ? [...options.candidates]
    : await detectZeroCostProviders({
        config: options.config,
        env,
        probeOllama: true,
        timeoutMs: 800,
        ...(options.detectOptions ?? {})
      });

  const eligible = discovered.filter((candidate) => {
    if (candidate.readiness !== 'ready') return false;
    const norm = normalizeZeroCostId(candidate.provider);
    if (tried.has(norm)) return false;
    // Never fail over to a cloud provider on network_error when offline Ollama is available
    return candidate.costTier === 'offline_free'
      || candidate.costTier === 'cloud_free'
      || candidate.costTier === 'peer_free';
  });

  if (eligible.length === 0) return null;

  eligible.sort((a, b) => {
    if (options.reason === 'network_error') {
      const aOffline = a.costTier === 'offline_free' ? 0 : 1;
      const bOffline = b.costTier === 'offline_free' ? 0 : 1;
      if (aOffline !== bOffline) return aOffline - bOffline;
    }
    const pa = FAILOVER_PRIORITY[normalizeZeroCostId(a.provider)] ?? 99;
    const pb = FAILOVER_PRIORITY[normalizeZeroCostId(b.provider)] ?? 99;
    return pa - pb;
  });

  const chosen = eligible[0];
  if (!chosen) return null;

  const chosenProvider = chosen.provider === 'gemini' ? 'gemini-free' : chosen.provider;
  return {
    provider: chosenProvider,
    model: chosen.model,
    apiKey: resolveKeyForFailoverCandidate(chosen, options.config, env),
    label: chosen.label,
    costTier: chosen.costTier,
    reason: chosen.reason
  };
}
