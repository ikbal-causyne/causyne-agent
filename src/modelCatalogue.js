// THE model catalogue. One list, one truth.
//
// WHY THIS EXISTS: on 2026-09-09 an audit found the supported-model list
// duplicated by hand in FIVE places, drifting independently:
//
//   1. alibaba-cloud/ui-config.js        /api/agent-models — overrides the app entirely
//   2. AgentViewModel.kt getModelsForProvider()  — the app's offline fallback
//   3. src/tui/home.js PROVIDERS         — the terminal home screen's defaults
//   4. src/config.js loadConfig()        — the first-run default
//   5. src/providers/anthropic.js        — the capability lists that decide behaviour
//
// ui-config.js already carried the comment "Three lists, one truth" — it was
// four, and the count was the smallest of the problems. The drift had shipped:

// does not publish (it uses dashes), which matched NONE of anthropic.js's
// capability lists and so silently disabled adaptive thinking and deferred
// tool loading and sent `temperature` to models that reject it. The terminal
// suggested `gpt-4o` and `gemini-2.5-pro` — models two generations old. And
// `gpt-6-astra`, `claude-opus-5` and `claude-fable-5-1` could not be selected

//
// This module is now the source. 3 and 4 import it. 1 and 2 cannot (they are a
// separately deployed Express service and a Kotlin file), so
// tests/modelCatalogue.test.js READS them and fails the build when they drift.
// That is the part that stops this recurring: fixing the lists fixes today,
// pinning them by test fixes every tomorrow.
//
// WHEN A PROVIDER SHIPS A NEW MODEL: add it here, run `npm test`, and the test
// will name every other file that must be updated to match.

/**
 * Selectable models per provider, newest first.
 *
 * The label keys are a stable configuration format, not display sugar.
 */
export const MODEL_CATALOGUE = {
  'DeepSeek': ['deepseek-v4-pro', 'deepseek-v4-flash'],
  'Qwen': ['qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-flash'],
  // Anthropic ids use DASHES and carry no date suffix. A dotted id here is a
  // bug, not a variant — see src/modelIds.js.
  'Anthropic': [
    'claude-fable-5-1',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-sonnet-5',
    'claude-haiku-4-5'
  ],
  // GPT-6 Astra leads: it is the current flagship and the only model in the
  // line-up trained for computer use. It is also the priciest ($10/$50 against
  // Sol's $5/$30), which is why it heads the list but is not the default.
  'OpenAI': ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.4-mini'],
  'Gemini': ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.1-pro', 'gemini-3.1-flash-lite'],
  // Standard first. The -contributor variants are cheaper because Meta trains
  // on the user's prompts and completions, so they must be a choice made
  // deliberately, never the one at the top of the list.
  'Meta (Muse)': [
    'muse-spark-1.3',
    'muse-spark-1.2',
    'muse-spark-1.1',
    'muse-spark-1.3-contributor',
    'muse-spark-1.2-contributor'
  ],
  'Ollama (Local)': ['llama3', 'mistral', 'gemma2', 'custom'],
  'Alibaba (DashScope)': [
    'qwen3.7-max', 'qwen3.7-plus', 'kimi-k2.7-code', 'kimi-k2.6',
    'kimi-k2.5', 'kimi-k2-thinking', 'Moonshot-Kimi-K2-Instruct',
    'deepseek-v4-flash', 'deepseek-v4-pro'
  ],
  'Moonshot (Kimi)': ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'],
  'xAI (Grok)': ['grok-4.5', 'grok-latest']
};

/** Provider labels in picker order. */
export const PROVIDER_LABELS = Object.keys(MODEL_CATALOGUE);


export const DEFAULT_MODEL_BY_PROVIDER = {
  deepseek: 'deepseek-v4-pro',
  qwen: 'qwen3.7-plus',
  'dashscope-byok': 'qwen3.7-plus',
  dashscope: 'qwen3.7-plus',
  muse: 'muse-spark-1.3',
  anthropic: 'claude-opus-5',
  openai: 'gpt-5.6-sol',
  gemini: 'gemini-3.5-flash',
  moonshot: 'kimi-k3',
  xai: 'grok-4.5',
  ollama: 'llama3',
  'openai-compatible': ''
};

/**
 * Every id this catalogue can produce, flattened. Used by the drift test and
 * by anything that needs to ask "is this a model we claim to support?".
 *
 * @returns {string[]} unique ids, order not significant
 */
/**
 * The cheapest model of each provider that is still competent at UTILITY work —
 * classification, keyword extraction, log filtering, condensation, triage.
 *
 * SAME PROVIDER, ALWAYS. The research spec proposes routing light work to
 * "DeepSeek V4 Flash or GPT-4o mini" regardless of what the user configured.
 * That cannot work here: Causyne is BYOK and the user holds exactly ONE key.
 * Routing across providers would call an endpoint there is no credential for,
 * so a route may only ever move WITHIN the configured provider.
 *
 * MUSE IS DELIBERATELY ABSENT. Its cheap tier is the `-contributor` variant,
 * which is cheaper precisely because Meta trains on the user's prompts and
 * completions. That is a privacy decision, not a price decision, and it must
 * stay something the user opts into by hand — never something a cost optimiser
 * does to them silently. A muse user simply gets no utility routing.
 *
 * Absent providers (moonshot, xai, ollama, openai-compatible) have no published
 * second tier we can rely on, so they route to nothing and pay full rate. A
 * guess here would show up on someone's invoice.
 *
 * @type {Record<string, string>}
 */
export const UTILITY_MODEL_BY_PROVIDER = {
  deepseek: 'deepseek-v4-flash',      // $0.14/$0.28 against pro's $0.435/$0.87
  qwen: 'qwen3.6-flash',              // $0.19/$1.13 against plus's $0.32/$1.28
  dashscope: 'qwen3.6-flash',
  'dashscope-byok': 'qwen3.6-flash',
  anthropic: 'claude-haiku-4-5',      // $1/$5 against opus's $5/$25
  openai: 'gpt-5.4-mini',             // $0.75/$4.50 against sol's $5/$30
  gemini: 'gemini-3.1-flash-lite'     // $0.25/$1.50 against flash's $1.50/$9
};

export function allCatalogueModels() {
  return [...new Set(Object.values(MODEL_CATALOGUE).flat())];
}
