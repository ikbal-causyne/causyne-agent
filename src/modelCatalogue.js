// THE model catalogue. One list, one truth.
/**
 * Models published by a peer CLI's own `models` command. Only ids verified
 * against the installed binary live here; a peer with no published list is
 * absent and uses its own default rather than an invented id.
 */
export const PEER_MODEL_CATALOGUE = {
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
export const MODEL_CATALOGUE = {
    'DeepSeek': ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
    'Qwen': [
        'qwen3-coder-flash',
        'qwen3.8-max',
        'qwen3.8-flash',
        'qwen3.7-max',
        'qwen3.7-plus',
        'qwen-plus',
        'qwen-max',
        'qwen-turbo',
        'qwen2.5-coder-32b-instruct',
        'qwen2.5-72b-instruct'
    ],
    'Anthropic': [
        'claude-sonnet-5-5',
        'claude-opus-5-5',
        'claude-haiku-5-5',
        'claude-fable-5-2',
        'claude-fable-5-1',
        'claude-opus-5',
        'claude-opus-4-8',
        'claude-sonnet-5',
        'claude-haiku-4-5',
        'claude-3-7-sonnet',
        'claude-3-5-sonnet',
        'claude-3-5-haiku',
        'claude-3-opus'
    ],
    'OpenAI': [
        'gpt-6.1-sol',
        'gpt-6-astra',
        'gpt-6.1-terra',
        'gpt-6-luna',
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
        'gpt-5.4-mini',
        'gpt-4o',
        'gpt-4o-mini',
        'o3-mini',
        'o1'
    ],
    'Gemini': [
        'gemini-4-argon',
        'gemini-3.8-flash',
        'gemini-3.5-flash',
        'gemini-3.5-flash-lite',
        'gemini-2.5-pro',
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
        'gemini-2.0-flash',
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
        'qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen3-coder-flash', 'qwen2.5-coder-32b-instruct',
        'qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-max', 'qwen3.7-plus',
        'kimi-k2.7-code', 'kimi-k2.6', 'kimi-k2.5', 'kimi-k2-thinking',
        'Moonshot-Kimi-K2-Instruct', 'deepseek-flash', 'deepseek-v4-pro'
    ],
    'Moonshot (Kimi)': [
        'k3.1-pro',
        'k3.1-pro-highspeed',
        'k3',
        'kimi-for-coding',
        'kimi-for-coding-highspeed',
        'kimi-k3',
        'kimi-k2.7-code',
        'kimi-k2.6'
    ],
    'xAI (Grok)': ['grok-4.7', 'grok-4.6', 'grok-420-reasoning', 'grok-3', 'grok-3-mini', 'grok-2-1212', 'grok-latest'],
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
    'OpenRouter (Free)': ['openrouter/free'],
    'Groq (Free Tier)': [
        'openai/gpt-oss-120b',
        'qwen/qwen3-32b',
        'llama-3.3-70b-versatile',
        'llama-3.1-8b-instant'
    ],
    'Cerebras (Free Tier)': [
        'qwen-3-32b',
        'llama-3.3-70b',
        'gpt-oss-120b',
        'llama3.1-8b'
    ],
    'Mistral (Free Tier)': [
        'devstral-small-latest',
        'codestral-latest',
        'mistral-small-latest',
        'mistral-large-latest'
    ]
};
/** Provider labels in picker order. */
export const PROVIDER_LABELS = Object.keys(MODEL_CATALOGUE);
export const DEFAULT_MODEL_BY_PROVIDER = {
    deepseek: 'deepseek-flash',
    qwen: 'qwen2.5-coder-32b-instruct',
    'dashscope-byok': 'qwen-plus',
    dashscope: 'qwen-plus',
    muse: 'muse-spark-1.3',
    anthropic: 'claude-sonnet-5-5',
    openai: 'gpt-4o',
    gemini: 'gemini-2.5-pro',
    'gemini-free': 'gemini-2.5-flash',
    moonshot: 'k3.1-pro',
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
    groq: 'openai/gpt-oss-120b',
    cerebras: 'qwen-3-32b',
    mistral: 'devstral-small-latest',
    pi: 'default',
    'openai-compatible': ''
};
export const UTILITY_MODEL_BY_PROVIDER = {
    deepseek: 'deepseek-flash',
    qwen: 'qwen3.8-flash',
    dashscope: 'qwen3.8-flash',
    'dashscope-byok': 'qwen3.8-flash',
    anthropic: 'claude-haiku-5-5',
    openai: 'gpt-5.4-mini',
    gemini: 'gemini-3.5-flash-lite',
    'gemini-free': 'gemini-2.5-flash-lite',
    openrouter: 'openrouter/free',
    groq: 'llama-3.1-8b-instant',
    cerebras: 'llama3.1-8b',
    mistral: 'mistral-small-latest'
};
export function allCatalogueModels() {
    return [...new Set(Object.values(MODEL_CATALOGUE).flat())];
}
