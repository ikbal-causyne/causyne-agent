// THE model catalogue. One list, one truth.

/**
 * Models published by a peer CLI's own `models` command. Only ids verified
 * against the installed binary live here; a peer with no published list is
 * absent and uses its own default rather than an invented id.
 */
export const PEER_MODEL_CATALOGUE: Record<string, string[]> = {
  opencode: [
    'opencode/beam-free',
    'opencode/big-pickle',
    'opencode/deepseek-v4.1-flash-free',
    'opencode/flint-40b-free',
    'opencode/glm-5.3-flash-free',
    'opencode/mimo-v2.6-flash-free',
    'opencode/nemotron-3-ultra-free',
    'opencode/nemotron-3.5-lightning-free',
    'opencode/nemotron-3.5-super-vl-free'
  ],
  claude: ['sonnet', 'opus', 'haiku']
};

/**
 * Selectable models per provider, newest first.
 *
 * The label keys are a stable configuration format, not display sugar.
 */
export const MODEL_CATALOGUE: Record<string, string[]> = {
  'DeepSeek': ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-pro', 'deepseek-v4-flash'],
  'Qwen': [
    'qwen2.5-coder-32b-instruct',
    'qwen2.5-72b-instruct',
    'qwen-max',
    'qwen-plus',
    'qwen-turbo',
    'qwen3.7-max',
    'qwen3.7-plus',
    'qwen3.6-flash'
  ],
  'Anthropic': [
    'claude-3-7-sonnet',
    'claude-3-5-sonnet',
    'claude-3-5-haiku',
    'claude-3-opus',
    'claude-fable-5-1',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-sonnet-5',
    'claude-haiku-4-5'
  ],
  'OpenAI': [
    'gpt-4o',
    'gpt-4o-mini',
    'o3-mini',
    'o1',
    'gpt-6-astra',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.4-mini'
  ],
  'Gemini': [
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-pro',
    'gemini-1.5-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.1-pro',
    'gemini-3.1-flash-lite'
  ],
  'Meta (Muse)': [
    'muse-spark-1.3',
    'muse-spark-1.2',
    'muse-spark-1.1',
    'muse-spark-1.3-contributor',
    'muse-spark-1.2-contributor'
  ],
  'Ollama (Local)': ['llama3.3', 'qwen2.5-coder', 'deepseek-r1', 'llama3', 'mistral', 'gemma2', 'custom'],
  'Alibaba (DashScope)': [
    'qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen2.5-coder-32b-instruct',
    'qwen3.7-max', 'qwen3.7-plus', 'kimi-k2.7-code', 'kimi-k2.6',
    'kimi-k2.5', 'kimi-k2-thinking', 'Moonshot-Kimi-K2-Instruct',
    'deepseek-v4-flash', 'deepseek-v4-pro'
  ],
  'Moonshot (Kimi)': ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'],
  'xAI (Grok)': ['grok-3', 'grok-3-mini', 'grok-2-1212', 'grok-4.5', 'grok-latest'],
  'Google Antigravity': [
    'Gemini 3.8 Flash (Low)',
    'Gemini 3.8 Flash (Medium)',
    'Gemini 3.8 Flash (High)',
    'Gemini 4 Argon (Low)',
    'Gemini 4 Argon (Medium)',
    'Gemini 4 Argon (High)',
    'Claude Sonnet 5.5 (Low)',
    'Claude Sonnet 5.5 (Medium)',
    'Claude Sonnet 5.5 (High)',
    'Claude Opus 5.5 (Low)',
    'Claude Opus 5.5 (Medium)',
    'Claude Opus 5.5 (High)',
    'GPT-OSS 120B (Medium)'
  ],
  'Pi (Local Peer)': ['default'],
  'ACP (Peer Agents)': ['opencode', 'claude', 'codex', 'gemini', 'cursor', 'hermes', 'qwen', 'copilot', 'kimi', 'goose'],
  'OpenCode (ACP)': PEER_MODEL_CATALOGUE.opencode ?? [],
  'Claude Code (ACP)': PEER_MODEL_CATALOGUE.claude ?? [],
  'OpenRouter (Free)': ['openrouter/free']
};

/** Provider labels in picker order. */
export const PROVIDER_LABELS: string[] = Object.keys(MODEL_CATALOGUE);

export const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  deepseek: 'deepseek-chat',
  qwen: 'qwen2.5-coder-32b-instruct',
  'dashscope-byok': 'qwen-plus',
  dashscope: 'qwen-plus',
  muse: 'muse-spark-1.3',
  anthropic: 'claude-3-7-sonnet',
  openai: 'gpt-4o',
  gemini: 'gemini-2.5-pro',
  moonshot: 'kimi-k3',
  xai: 'grok-3',
  ollama: 'llama3.3',
  acp: 'opencode',
  'acp/opencode': 'opencode/beam-free',
  'acp/claude': 'sonnet',
  'acp/codex': 'codex',
  'acp/gemini': 'gemini',
  'acp/cursor': 'cursor',
  'acp/qwen': 'qwen',
  'acp/copilot': 'copilot',
  'acp/kimi': 'kimi',
  'acp/goose': 'goose',
  'acp/hermes': 'hermes',
  antigravity: 'Gemini 3.8 Flash (Low)',
  openrouter: 'openrouter/free',
  pi: 'default',
  'openai-compatible': ''
};

export const UTILITY_MODEL_BY_PROVIDER: Record<string, string> = {
  deepseek: 'deepseek-v4-flash',
  qwen: 'qwen3.6-flash',
  dashscope: 'qwen3.6-flash',
  'dashscope-byok': 'qwen3.6-flash',
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-5.4-mini',
  gemini: 'gemini-3.1-flash-lite',
  openrouter: 'openrouter/free'
};

export function allCatalogueModels(): string[] {
  return [...new Set(Object.values(MODEL_CATALOGUE).flat())];
}
