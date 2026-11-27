// Dynamic, model-aware reasoning variant / effort resolver across ACP peers,
// Antigravity live siblings, local Ollama capabilities, BYOK, and Free providers.
// Never hardcodes a single effort list for all models: adapts strictly to what
// the active provider and model genuinely support.

import { ANTIGRAVITY_MODELS, ANTIGRAVITY_MODEL_IDS, isAntigravityProvider, resolveAgyEffort } from './providers/antigravity.js';
import { isAcpProvider } from './providers/acp.js';
import type { AcpDiscoveredVariantOption } from './acp/protocol.js';

export type VariantSource = 'acp_live' | 'peer_catalogue' | 'agy_models' | 'ollama_live' | 'model_family' | 'none';

export interface VariantOption {
  id: string;
  label: string;
  description: string;
  source: Exclude<VariantSource, 'none'>;
  targetModelId?: string | undefined;
  acpConfigId?: string | undefined;
}

export interface ModelVariantSpec {
  provider: string;
  model: string;
  supported: boolean;
  source: VariantSource;
  currentVariant: string | null;
  defaultVariant: string | null;
  acpConfigId?: string | undefined;
  options: VariantOption[];
  note: string;
}

export interface ResolveModelVariantsInput {
  provider: string;
  model: string;
  currentVariant?: string | null | undefined;
  liveAcpVariant?: AcpDiscoveredVariantOption | null | undefined;
  peerModelVariants?: readonly string[] | null | undefined;
  ollamaSupportsThinking?: boolean | null | undefined;
  availableAgyModels?: readonly string[] | undefined;
}

const STANDARD_DESCRIPTIONS: Record<string, { label: string; description: string }> = {
  off: { label: 'Off', description: 'Disable extended reasoning for fastest, lowest-token replies' },
  none: { label: 'None (Off)', description: 'Minimal/no reasoning tokens for instant direct responses' },
  minimal: { label: 'Minimal', description: 'Very light reasoning with minimal latency overhead' },
  low: { label: 'Low', description: 'Fast reasoning suited for routine edits and quick questions' },
  medium: { label: 'Medium', description: 'Balanced reasoning depth and speed for everyday engineering' },
  high: { label: 'High', description: 'Deep multi-step reasoning for complex bugs and architecture' },
  xhigh: { label: 'Extra High (xhigh)', description: 'Extended deep thinking for hard research and system design' },
  max: { label: 'Max', description: 'Maximum reasoning depth supported by this model' },
  ultra: { label: 'Ultra', description: 'Ultra-deep reasoning tier exposed by this model or peer' },
  on: { label: 'On', description: 'Enable native chain-of-thought reasoning' }
};

const EFFORT_RANK: readonly string[] = [
  'off',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
  'on'
];

function describeOption(id: string, customLabel?: string, customDesc?: string): { label: string; description: string } {
  const key = id.trim().toLowerCase();
  const known = Object.hasOwn(STANDARD_DESCRIPTIONS, key) ? STANDARD_DESCRIPTIONS[key]! : null;
  const fallbackLabel = key
    ? key.replace(/[-_]+/g, ' ').replace(/\b[a-z]/g, (ch) => ch.toUpperCase())
    : id;
  return {
    label: customLabel?.trim() || known?.label || fallbackLabel,
    description: customDesc?.trim() || known?.description || `Set reasoning variant to ${id}`
  };
}

function makeFamilyOptions(ids: readonly string[]): VariantOption[] {
  return ids.map((id) => {
    const meta = describeOption(id);
    return {
      id,
      label: meta.label,
      description: meta.description,
      source: 'model_family'
    };
  });
}

/**
 * Normalize user-typed variant aliases into canonical tokens while preserving
 * exact option IDs exposed by live ACP peers.
 */
export function normalizeVariantToken(raw: string): string {
  const clean = String(raw || '').trim().toLowerCase();
  if (!clean) return '';
  if (clean === 'default' || clean === 'auto' || clean === 'reset') return 'auto';
  if (clean === 'extra-high' || clean === 'extra_high' || clean === 'extra high' || clean === 'xh' || clean === 'eh') {
    return 'xhigh';
  }
  if (clean === 'disabled' || clean === 'disable' || clean === 'false') return 'off';
  if (clean === 'enabled' || clean === 'enable' || clean === 'true') return 'on';
  if (clean === 'med' || clean === 'mid' || clean === 'normal' || clean === 'balanced') return 'medium';
  if (clean === 'min') return 'minimal';
  if (clean === 'lo' || clean === 'fast') return 'low';
  if (clean === 'hi' || clean === 'deep') return 'high';
  if (clean === 'maximum') return 'max';
  return clean;
}

/**
 * Match a user-supplied variant argument against the active model's real supported options.
 */
export function matchVariantOption(spec: ModelVariantSpec, rawInput: string): VariantOption | null {
  const rawLower = String(rawInput || '').trim().toLowerCase();
  const normalized = normalizeVariantToken(rawInput);
  if (!normalized || spec.options.length === 0) return null;

  const exact = spec.options.find(
    (opt) => opt.id.toLowerCase() === rawLower || opt.id.toLowerCase() === normalized || opt.label.toLowerCase() === rawLower
  );
  if (exact) return exact;

  // Map friendly cross-family synonyms ONLY when the target exists on this model
  const fallbacks: Record<string, readonly string[]> = {
    off: ['none', 'off', 'disabled'],
    none: ['off', 'none', 'minimal'],
    ultra: ['ultra', 'max', 'xhigh'],
    max: ['max', 'ultra', 'xhigh'],
    xhigh: ['xhigh', 'ultra', 'max']
  };
  const candidates = Object.hasOwn(fallbacks, normalized) ? fallbacks[normalized]! : [];
  for (const cand of candidates) {
    const hit = spec.options.find((opt) => opt.id.toLowerCase() === cand);
    if (hit) return hit;
  }
  return null;
}

export function resolveBudgetTokensForVariant(variant: string | null | undefined, maxCap = 48_000): number | null {
  const norm = normalizeVariantToken(variant || '');
  switch (norm) {
    case 'off':
    case 'none':
      return 0;
    case 'minimal':
      return Math.min(1024, maxCap);
    case 'low':
      return Math.min(4096, maxCap);
    case 'medium':
      return Math.min(10_240, maxCap);
    case 'high':
      return Math.min(24_576, maxCap);
    case 'xhigh':
      return Math.min(32_768, maxCap);
    case 'max':
    case 'ultra':
      return maxCap;
    default:
      return null;
  }
}

function stripAgyEffortSuffix(modelLabelOrSlug: string): { base: string; effort: string | null } {
  const trimmed = modelLabelOrSlug.trim();
  const parenMatch = /^(.+?)\s*\((low|medium|high|extra\s+high|xhigh|max|ultra|minimal|off)\)\s*$/i.exec(trimmed);
  if (parenMatch && parenMatch[1] && parenMatch[2]) {
    return {
      base: parenMatch[1].trim().toLowerCase(),
      effort: normalizeVariantToken(parenMatch[2])
    };
  }
  const dashMatch = /^(.+?)-(low|medium|high|xhigh|max|ultra|minimal|off)$/i.exec(trimmed);
  if (dashMatch && dashMatch[1] && dashMatch[2]) {
    return {
      base: dashMatch[1].trim().toLowerCase(),
      effort: normalizeVariantToken(dashMatch[2])
    };
  }
  return { base: trimmed.toLowerCase(), effort: null };
}

function detectAntigravitySiblingVariants(
  model: string,
  availableModels: readonly string[]
): { options: VariantOption[]; currentEffort: string | null } {
  const cleanModel = model.trim();
  if (!cleanModel) return { options: [], currentEffort: null };
  const activeParsed = stripAgyEffortSuffix(cleanModel);
  const activeSlug = ANTIGRAVITY_MODEL_IDS[cleanModel] || cleanModel;
  const activeSlugParsed = stripAgyEffortSuffix(activeSlug);

  const byEffort = new Map<string, VariantOption>();
  for (const candidate of availableModels) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const candLabel = candidate.trim();
    const candSlug = ANTIGRAVITY_MODEL_IDS[candLabel] || candLabel;
    const parsedLabel = stripAgyEffortSuffix(candLabel);
    const parsedSlug = stripAgyEffortSuffix(candSlug);
    const effort = parsedLabel.effort ?? parsedSlug.effort;
    if (!effort) continue;

    const sameFamily =
      parsedLabel.base === activeParsed.base
      || parsedSlug.base === activeSlugParsed.base
      || parsedSlug.base === activeParsed.base;
    if (!sameFamily) continue;

    if (!byEffort.has(effort)) {
      const meta = describeOption(effort);
      byEffort.set(effort, {
        id: effort,
        label: meta.label,
        description: `${meta.description} (${candLabel})`,
        source: 'agy_models',
        targetModelId: candLabel
      });
    }
  }

  const options = Array.from(byEffort.values()).sort((a, b) => {
    const ra = EFFORT_RANK.indexOf(a.id);
    const rb = EFFORT_RANK.indexOf(b.id);
    return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb) || a.id.localeCompare(b.id);
  });
  const currentEffort = activeParsed.effort ?? activeSlugParsed.effort ?? resolveAgyEffort(cleanModel);
  return { options, currentEffort };
}

function detectModelFamilyVariants(providerNorm: string, rawModel: string): {
  options: VariantOption[];
  defaultVariant: string | null;
  note: string;
} {
  const m = rawModel.trim().toLowerCase();
  if (!m) {
    return { options: [], defaultVariant: null, note: 'No active model selected. Run /model first.' };
  }

  // Strip provider/namespace prefix for OpenRouter / ACP model IDs (e.g. "openai/gpt-5.4", "anthropic/claude-opus-4-7", "opencode/gpt-5")
  const slashIdx = m.indexOf('/');
  const leaf = slashIdx >= 0 ? m.slice(slashIdx + 1).replace(/:free$/i, '') : m.replace(/:free$/i, '');

  // OpenRouter Free meta-router
  if (m === 'openrouter/free' || m === 'free') {
    return {
      options: makeFamilyOptions(['off', 'low', 'medium', 'high']),
      defaultVariant: 'medium',
      note: 'OpenRouter Free router forwards reasoning effort when the routed model supports thinking.'
    };
  }

  // 1. OpenAI & Codex reasoning families
  if (/^o[134]-pro(?:$|[-.])/.test(leaf)) {
    return {
      options: makeFamilyOptions(['medium', 'high']),
      defaultVariant: 'high',
      note: 'OpenAI Pro reasoning models support medium and high reasoning effort.'
    };
  }
  if (/^o[134](?:$|[-.])/.test(leaf)) {
    return {
      options: makeFamilyOptions(['low', 'medium', 'high']),
      defaultVariant: 'medium',
      note: 'OpenAI o-series reasoning models support low, medium, and high reasoning effort.'
    };
  }
  if (/^gpt-[56](?:$|[-.])/.test(leaf) && !leaf.includes('-chat')) {
    const supportsXhigh = /^gpt-5\.[2-9]|^gpt-6|codex/i.test(leaf);
    const levels = supportsXhigh
      ? ['none', 'low', 'medium', 'high', 'xhigh']
      : ['minimal', 'low', 'medium', 'high'];
    return {
      options: makeFamilyOptions(levels),
      defaultVariant: 'medium',
      note: supportsXhigh
        ? 'GPT-5.2+/Codex models support none, low, medium, high, and extra-high (xhigh) reasoning effort.'
        : 'GPT-5 models support minimal, low, medium, and high reasoning effort.'
    };
  }

  // 2. Anthropic Claude families
  if (leaf.startsWith('claude-')) {
    const alwaysOn = ['claude-fable-5', 'claude-mythos-5'].some((p) => leaf.startsWith(p));
    if (alwaysOn) {
      return {
        options: makeFamilyOptions(['low', 'medium', 'high', 'xhigh', 'max']),
        defaultVariant: 'high',
        note: 'This Claude model runs adaptive thinking by default with low through max effort levels.'
      };
    }
    const fullEffort = ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4.8', 'claude-opus-4.7'].some((p) => leaf.startsWith(p));
    if (fullEffort) {
      return {
        options: makeFamilyOptions(['off', 'low', 'medium', 'high', 'xhigh', 'max']),
        defaultVariant: 'high',
        note: 'Adaptive thinking with low, medium, high, extra-high (xhigh), and max effort.'
      };
    }
    const limitedEffort = ['claude-opus-4-6', 'claude-opus-4.6', 'claude-sonnet-4-6', 'claude-sonnet-4.6', 'claude-opus-4-5', 'claude-opus-4.5'].some((p) => leaf.startsWith(p));
    if (limitedEffort) {
      return {
        options: makeFamilyOptions(['off', 'low', 'medium', 'high']),
        defaultVariant: 'medium',
        note: 'Supports off, low, medium, and high reasoning effort.'
      };
    }
    const budgetThinking = ['claude-3-7-sonnet', 'claude-3.7-sonnet', 'claude-sonnet-4', 'claude-opus-4'].some((p) => leaf.startsWith(p));
    if (budgetThinking) {
      return {
        options: makeFamilyOptions(['off', 'low', 'medium', 'high', 'max']),
        defaultVariant: 'medium',
        note: 'Uses Anthropic extended thinking token budgets mapped from off through max.'
      };
    }
    return {
      options: [],
      defaultVariant: null,
      note: `${rawModel} is a non-reasoning Claude model with no tunable thinking variants.`
    };
  }

  // 3. Google Gemini families
  const geminiLeaf = leaf.replace(/\s+/g, '-');
  if (geminiLeaf.startsWith('gemini-')) {
    if (/^gemini-4-(?:neon|hydrogen)(?:$|[-.(])/.test(geminiLeaf)) {
      return {
        options: makeFamilyOptions(['low', 'medium', 'high', 'xhigh']),
        defaultVariant: 'medium',
        note: 'Gemini 4 Neon/Hydrogen supports low, medium, high, and extra-high (xhigh) thinking variants.'
      };
    }
    if (/^gemini-(?:3|4)/.test(geminiLeaf)) {
      const isFlash = geminiLeaf.includes('flash');
      const levels = isFlash ? ['minimal', 'low', 'medium', 'high'] : ['low', 'medium', 'high'];
      return {
        options: makeFamilyOptions(levels),
        defaultVariant: 'medium',
        note: 'Gemini 3/4 uses native thinkingLevel variants.'
      };
    }
    if (geminiLeaf.startsWith('gemini-2.5-flash') || geminiLeaf.startsWith('gemini-2-5-flash')) {
      return {
        options: makeFamilyOptions(['off', 'low', 'medium', 'high']),
        defaultVariant: 'medium',
        note: 'Gemini 2.5 Flash maps variants to thinkingBudget tokens (0 to 24,576).'
      };
    }
    if (geminiLeaf.startsWith('gemini-2.5-pro') || geminiLeaf.startsWith('gemini-2-5-pro')) {
      return {
        options: makeFamilyOptions(['low', 'medium', 'high']),
        defaultVariant: 'medium',
        note: 'Gemini 2.5 Pro runs with thinking enabled across low, medium, and high budgets.'
      };
    }
    return {
      options: [],
      defaultVariant: null,
      note: `${rawModel} does not expose tunable thinking variants.`
    };
  }

  // 4. xAI Grok families
  if (leaf.startsWith('grok-')) {
    if (leaf.includes('non-reasoning')) {
      return { options: [], defaultVariant: null, note: `${rawModel} is a non-reasoning Grok model.` };
    }
    if (leaf.includes('grok-420-reasoning') || (leaf.includes('grok-4') && leaf.includes('reasoning'))) {
      return {
        options: makeFamilyOptions(['low', 'medium', 'high', 'xhigh']),
        defaultVariant: 'medium',
        note: 'Grok reasoning models support low, medium, high, and extra-high (xhigh) effort.'
      };
    }
    if (leaf.includes('grok-3-mini')) {
      return {
        options: makeFamilyOptions(['low', 'high']),
        defaultVariant: 'low',
        note: 'Grok 3 Mini supports low and high reasoning effort.'
      };
    }
    return { options: [], defaultVariant: null, note: `${rawModel} does not expose tunable reasoning_effort variants.` };
  }

  // 5. Qwen / DashScope thinking models
  if (leaf.startsWith('qwen3') || leaf.startsWith('qwen-3') || leaf.startsWith('qwq')) {
    if (providerNorm === 'qwen' || providerNorm === 'dashscope-byok' || providerNorm === 'dashscope' || providerNorm === 'openrouter' || providerNorm === 'openrouter-free') {
      return {
        options: makeFamilyOptions(['off', 'low', 'medium', 'high']),
        defaultVariant: 'medium',
        note: 'Qwen3/QwQ models support toggling thinking off or tuning thinking budget (low/medium/high).'
      };
    }
    return {
      options: makeFamilyOptions(['low', 'medium', 'high']),
      defaultVariant: 'medium',
      note: 'Qwen3 reasoning effort passed via reasoning_effort.'
    };
  }

  // 6. Moonshot Kimi thinking models
  if (leaf.startsWith('kimi-k2.5') || leaf.startsWith('kimi-k2.7') || leaf.includes('k2-thinking') || leaf.startsWith('k3')) {
    return {
      options: makeFamilyOptions(['off', 'low', 'medium', 'high']),
      defaultVariant: 'medium',
      note: 'Kimi thinking models support off, low, medium, and high reasoning depth.'
    };
  }

  // 7. GPT-OSS models (Groq / Cerebras / OpenRouter / OpenAI-compatible)
  if (leaf.includes('gpt-oss')) {
    return {
      options: makeFamilyOptions(['low', 'medium', 'high']),
      defaultVariant: 'medium',
      note: 'GPT-OSS models support low, medium, and high reasoning effort.'
    };
  }

  // 8. Muse
  if (providerNorm === 'muse' || providerNorm === 'meta' || leaf.startsWith('muse')) {
    return {
      options: makeFamilyOptions(['low', 'medium', 'high', 'xhigh']),
      defaultVariant: 'medium',
      note: 'Muse reasoning supports low, medium, high, and extra-high (xhigh) effort.'
    };
  }

  // 9. DeepSeek R1 / Reasoner
  if (leaf.includes('deepseek-r1') || leaf.includes('reasoner')) {
    if (providerNorm === 'deepseek') {
      return {
        options: [],
        defaultVariant: null,
        note: 'DeepSeek Reasoner runs fixed native chain-of-thought. Switch to deepseek-chat via /model for non-reasoning mode.'
      };
    }
    return {
      options: makeFamilyOptions(['low', 'medium', 'high']),
      defaultVariant: 'medium',
      note: 'Reasoning effort forwarded to the hosted DeepSeek-R1 endpoint.'
    };
  }

  return {
    options: [],
    defaultVariant: null,
    note: `${rawModel} does not expose tunable reasoning variants.`
  };
}

/**
 * Resolve the real, supported reasoning variants for the currently active
 * provider and model without hardcoding a single global list.
 */
export function resolveModelVariants(input: ResolveModelVariantsInput): ModelVariantSpec {
  const provider = String(input.provider || '').trim();
  const providerNorm = provider.toLowerCase();
  const model = String(input.model || '').trim();
  const currentNorm = input.currentVariant ? normalizeVariantToken(input.currentVariant) : null;

  // 1. Live ACP peer configOptions (highest authority — exact options advertised by peer)
  if (isAcpProvider(providerNorm) && input.liveAcpVariant && input.liveAcpVariant.options.length > 0) {
    const live = input.liveAcpVariant;
    const options: VariantOption[] = [];
    for (const opt of live.options) {
      const cleanVal = opt.value.trim();
      if (!cleanVal || cleanVal.toLowerCase() === 'default') continue;
      const meta = describeOption(cleanVal, opt.name, opt.description);
      options.push({
        id: cleanVal,
        label: meta.label,
        description: meta.description,
        source: 'acp_live',
        acpConfigId: live.configOptionId
      });
    }
    if (options.length > 0) {
      const liveCur = live.currentValue && live.currentValue.trim().toLowerCase() !== 'default'
        ? live.currentValue.trim()
        : null;
      return {
        provider,
        model,
        supported: true,
        source: 'acp_live',
        currentVariant: liveCur || (currentNorm && currentNorm !== 'auto' ? currentNorm : null),
        defaultVariant: liveCur || options[0]?.id || null,
        acpConfigId: live.configOptionId,
        options,
        note: `Live variants discovered directly from ACP peer config option "${live.configOptionId}".`
      };
    }
  }

  // 2. Authoritative ACP peer model catalogue (e.g. `opencode models --verbose` per-model `variants` map)
  if (isAcpProvider(providerNorm) && Array.isArray(input.peerModelVariants)) {
    const seen = new Set<string>();
    const rawIds: string[] = [];
    for (const item of input.peerModelVariants) {
      const clean = String(item || '').trim();
      const lower = clean.toLowerCase();
      if (!clean || lower === 'default' || seen.has(lower)) continue;
      seen.add(lower);
      rawIds.push(clean);
    }
    rawIds.sort((a, b) => {
      const ra = EFFORT_RANK.indexOf(a.toLowerCase());
      const rb = EFFORT_RANK.indexOf(b.toLowerCase());
      return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb) || a.localeCompare(b);
    });
    if (rawIds.length > 0) {
      const options: VariantOption[] = rawIds.map((id) => {
        const meta = describeOption(id);
        return {
          id,
          label: meta.label,
          description: meta.description,
          source: 'peer_catalogue'
        };
      });
      const validCurrent = currentNorm && options.some((o) => o.id.toLowerCase() === currentNorm)
        ? options.find((o) => o.id.toLowerCase() === currentNorm)!.id
        : null;
      return {
        provider,
        model,
        supported: true,
        source: 'peer_catalogue',
        currentVariant: validCurrent,
        defaultVariant: null,
        options,
        note: `Exact variants published by ${provider} for "${model}".`
      };
    }
    return {
      provider,
      model,
      supported: false,
      source: 'none',
      currentVariant: null,
      defaultVariant: null,
      options: [],
      note: `${provider} publishes no tunable variants for "${model || 'this model'}".`
    };
  }

  // 3. Antigravity live sibling models (discovers exact effort suffixes published by user's account)
  if (isAntigravityProvider(providerNorm)) {
    const pool = input.availableAgyModels && input.availableAgyModels.length > 0
      ? input.availableAgyModels
      : ANTIGRAVITY_MODELS;
    const { options, currentEffort } = detectAntigravitySiblingVariants(model, pool);
    if (options.length > 0) {
      const activeId = (currentNorm && options.some((o) => o.id === currentNorm))
        ? currentNorm
        : (currentEffort && options.some((o) => o.id === currentEffort) ? currentEffort : options[0]!.id);
      return {
        provider,
        model,
        supported: options.length > 1,
        source: 'agy_models',
        currentVariant: activeId,
        defaultVariant: currentEffort || options[0]?.id || null,
        options,
        note: options.length > 1
          ? 'Variants detected dynamically from sibling models exposed by Antigravity CLI.'
          : `Antigravity exposes only "${options[0]?.label ?? activeId}" for this model family.`
      };
    }
  }

  // 3. Local Ollama models (live /api/show capabilities + local reasoning model detection)
  if (providerNorm === 'ollama') {
    const lowered = model.toLowerCase();
    if (lowered.includes('gpt-oss')) {
      const options: VariantOption[] = (['low', 'medium', 'high'] as const).map((id) => {
        const meta = describeOption(id);
        return { id, label: meta.label, description: meta.description, source: 'ollama_live' };
      });
      return {
        provider,
        model,
        supported: true,
        source: 'ollama_live',
        currentVariant: currentNorm,
        defaultVariant: 'medium',
        options,
        note: 'Ollama gpt-oss supports native low, medium, and high thinking levels.'
      };
    }
    const knownLocalThinking =
      input.ollamaSupportsThinking === true
      || lowered.includes('qwen3')
      || lowered.includes('qwen-3')
      || lowered.includes('deepseek-r1')
      || lowered.includes('qwq')
      || lowered.includes('magistral')
      || lowered.includes('cogito');
    if (knownLocalThinking && input.ollamaSupportsThinking !== false) {
      const options: VariantOption[] = (['off', 'on'] as const).map((id) => {
        const meta = describeOption(id);
        return { id, label: meta.label, description: meta.description, source: 'ollama_live' };
      });
      return {
        provider,
        model,
        supported: true,
        source: 'ollama_live',
        currentVariant: currentNorm,
        defaultVariant: 'on',
        options,
        note: 'Local Ollama thinking model supports toggling native reasoning on or off.'
      };
    }
    return {
      provider,
      model,
      supported: false,
      source: 'none',
      currentVariant: null,
      defaultVariant: null,
      options: [],
      note: `Local Ollama model "${model}" does not advertise thinking capabilities.`
    };
  }

  // 4. Universal BYOK / Free / pre-handshake ACP model-family detection
  const family = detectModelFamilyVariants(providerNorm, model);
  if (family.options.length > 0) {
    const validCurrent = currentNorm && family.options.some((o) => o.id === currentNorm)
      ? currentNorm
      : null;
    const acpNote = isAcpProvider(providerNorm)
      ? `${family.note} (Live ACP peer configOptions will take precedence automatically once connected.)`
      : family.note;
    return {
      provider,
      model,
      supported: true,
      source: 'model_family',
      currentVariant: validCurrent,
      defaultVariant: family.defaultVariant,
      options: family.options,
      note: acpNote
    };
  }

  return {
    provider,
    model,
    supported: false,
    source: 'none',
    currentVariant: null,
    defaultVariant: null,
    options: [],
    note: isAcpProvider(providerNorm)
      ? `${provider} (${model || 'peer default'}) has not advertised reasoning variants yet. Start a turn to sync live ACP configOptions if supported by this peer.`
      : family.note
  };
}

/**
 * Reconcile a saved `reasoningEffort` against the currently selected `(provider, model)`
 * so stale variants from a previous provider/model (e.g. OpenCode `max` after switching
 * to Antigravity `Gemini 4 Neon (XHigh)`) are cleared cleanly instead of leaking into
 * CLI flags or status indicators.
 */
export function reconcileConfigVariant(
  config: Record<string, any>,
  options: {
    liveAgyModels?: readonly string[] | undefined;
    peerModelVariants?: readonly string[] | null | undefined;
  } = {}
): string {
  if (!config || typeof config !== 'object') return '';
  const raw = typeof config.reasoningEffort === 'string' ? config.reasoningEffort.trim() : '';
  if (!raw) {
    delete config.reasoningEffort;
    return '';
  }

  const provider = typeof config.provider === 'string' ? config.provider.trim() : '';
  const model = typeof config.model === 'string' ? config.model.trim() : '';

  // Antigravity encodes effort inside each model slug (e.g. `Gemini 4 Neon (XHigh)`),
  // and unsuffixed orchestrator models reject `--effort`. Never retain a separate
  // `reasoningEffort` override across Antigravity models.
  if (isAntigravityProvider(provider)) {
    delete config.reasoningEffort;
    delete config.reasoningBudgetTokens;
    return '';
  }

  const spec = resolveModelVariants({
    provider,
    model,
    currentVariant: raw,
    peerModelVariants: options.peerModelVariants,
    availableAgyModels: options.liveAgyModels
  });
  if (spec.source === 'agy_models' || !spec.supported) {
    delete config.reasoningEffort;
    delete config.reasoningBudgetTokens;
    return '';
  }
  const matched = matchVariantOption(spec, raw);
  if (!matched) {
    delete config.reasoningEffort;
    delete config.reasoningBudgetTokens;
    return '';
  }
  config.reasoningEffort = matched.id;
  return matched.id;
}
