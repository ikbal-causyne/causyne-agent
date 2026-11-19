/**
 * Causyne Agent — Subprocess Environment Secret Isolation (CWE-526)
 *
 * Strips host LLM provider API keys, Causyne internal vault/auth secrets, and
 * high-value cloud/registry secret credentials before spawning shell tools so
 * prompt-injected shell commands or untrusted build scripts cannot exfiltrate
 * ambient credentials via `env` / `printenv`.
 *
 * Developers who intentionally need a specific variable inside a subprocess
 * (for example, running an integration test suite) can opt in via
 * `CAUSYNE_PASSTHROUGH_ENV=VAR_A,VAR_B`. Internal Causyne vault/dev secrets
 * remain permanently excluded from subprocesses.
 */
export const ALWAYS_BLOCKED_SUBPROCESS_ENV = new Set([
    'CAUSYNE_VAULT_KEY',
    'CAUSYNE_DEV_SECRET',
    'CAUSYNE_DEV_TOKEN'
]);
export const SENSITIVE_EXACT_ENV_KEYS = new Set([
    // LLM & AI provider API keys
    'OPENAI_API_KEY',
    'OPENAI_ADMIN_KEY',
    'OPENAI_ORG_KEY',
    'ANTHROPIC_API_KEY',
    'CLAUDE_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'OPENROUTER_API_KEY',
    'DEEPSEEK_API_KEY',
    'XAI_API_KEY',
    'GROK_API_KEY',
    'MOONSHOT_API_KEY',
    'KIMI_API_KEY',
    'DASHSCOPE_API_KEY',
    'QWEN_API_KEY',
    'MUSE_API_KEY',
    'META_API_KEY',
    'LLAMA_API_KEY',
    'MISTRAL_API_KEY',
    'COHERE_API_KEY',
    'GROQ_API_KEY',
    'TOGETHER_API_KEY',
    'PERPLEXITY_API_KEY',
    'FIREWORKS_API_KEY',
    'CEREBRAS_API_KEY',
    'SAMBANOVA_API_KEY',
    'HUGGINGFACE_API_KEY',
    'HF_TOKEN',
    'HUGGING_FACE_HUB_TOKEN',
    'REPLICATE_API_TOKEN',
    'VOYAGE_API_KEY',
    'ELEVENLABS_API_KEY',
    'FAL_KEY',
    'STABILITY_API_KEY',
    'AZURE_OPENAI_API_KEY',
    // Causyne internal auth / vault credentials
    'CAUSYNE_API_KEY',
    'CAUSYNE_AUTH_TOKEN',
    'CAUSYNE_ACCESS_TOKEN',
    'CAUSYNE_SECRET',
    'CAUSYNE_VAULT_KEY',
    'CAUSYNE_DEV_SECRET',
    'CAUSYNE_DEV_TOKEN',
    // Cloud, package registry, VCS, and infrastructure raw secrets
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_SECURITY_TOKEN',
    'NPM_TOKEN',
    'NODE_AUTH_TOKEN',
    'YARN_NPM_AUTH_TOKEN',
    'PYPI_API_TOKEN',
    'TWINE_PASSWORD',
    'CARGO_REGISTRY_TOKEN',
    'RUBYGEMS_API_KEY',
    'NUGET_API_KEY',
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'GITLAB_TOKEN',
    'BITBUCKET_TOKEN',
    'SLACK_BOT_TOKEN',
    'SLACK_TOKEN',
    'DISCORD_TOKEN',
    'TELEGRAM_BOT_TOKEN',
    'STRIPE_SECRET_KEY',
    'STRIPE_API_KEY',
    'SENDGRID_API_KEY',
    'TWILIO_AUTH_TOKEN',
    'DATABASE_PASSWORD',
    'DB_PASSWORD',
    'PGPASSWORD',
    'MYSQL_PWD',
    'REDIS_PASSWORD',
    'DOCKER_PASSWORD',
    'GCP_SERVICE_ACCOUNT_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS_JSON',
    'CLOUDFLARE_API_TOKEN',
    'VERCEL_TOKEN',
    'NETLIFY_AUTH_TOKEN',
    'FLY_API_TOKEN',
    'DIGITALOCEAN_ACCESS_TOKEN',
    'HEROKU_API_KEY',
    'DATADOG_API_KEY',
    'SENTRY_AUTH_TOKEN'
]);
const SENSITIVE_ENV_SUFFIXES = [
    '_API_KEY',
    '_SECRET_KEY',
    '_PRIVATE_KEY',
    '_ACCESS_SECRET',
    '_AUTH_SECRET',
    '_CLIENT_SECRET',
    '_SIGNING_KEY',
    '_ENCRYPTION_KEY',
    '_MASTER_KEY',
    '_VAULT_KEY',
    '_SECRET_TOKEN',
    '_ACCESS_TOKEN',
    '_AUTH_TOKEN',
    '_REFRESH_TOKEN'
];
/**
 * Parses `CAUSYNE_PASSTHROUGH_ENV` (comma-separated exact variable names) into
 * an uppercased allowlist while excluding permanently blocked internal keys.
 */
export function parsePassthroughAllowlist(env, extra) {
    const allow = new Set();
    const addEntry = (raw) => {
        const trimmed = raw.trim().toUpperCase();
        if (!trimmed || trimmed === '*')
            return;
        if (ALWAYS_BLOCKED_SUBPROCESS_ENV.has(trimmed))
            return;
        allow.add(trimmed);
    };
    const envValue = env.CAUSYNE_PASSTHROUGH_ENV;
    if (typeof envValue === 'string' && envValue.trim().length > 0) {
        for (const part of envValue.split(',')) {
            addEntry(part);
        }
    }
    if (Array.isArray(extra)) {
        for (const part of extra) {
            if (typeof part === 'string')
                addEntry(part);
        }
    }
    return allow;
}
/**
 * Returns true if an environment variable name represents a secret credential
 * that must be stripped from shell subprocesses by default.
 */
export function isSensitiveEnvKey(key) {
    if (typeof key !== 'string' || key.length === 0)
        return false;
    const upper = key.toUpperCase();
    if (ALWAYS_BLOCKED_SUBPROCESS_ENV.has(upper))
        return true;
    if (SENSITIVE_EXACT_ENV_KEYS.has(upper))
        return true;
    if (upper.startsWith('CAUSYNE_')) {
        if (upper.includes('KEY') ||
            upper.includes('TOKEN') ||
            upper.includes('SECRET') ||
            upper.includes('PASSWORD') ||
            upper.includes('CREDENTIAL')) {
            return true;
        }
    }
    for (const suffix of SENSITIVE_ENV_SUFFIXES) {
        if (upper.endsWith(suffix))
            return true;
    }
    return false;
}
/**
 * Returns a copy of `baseEnv` (default `process.env`) with sensitive API keys
 * and secrets removed unless explicitly listed in `CAUSYNE_PASSTHROUGH_ENV` or
 * `options.passthrough`. Internal vault/dev keys are never passed through.
 */
export function sanitizeSubprocessEnv(baseEnv, options) {
    const source = baseEnv ?? process.env;
    const allowlist = parsePassthroughAllowlist(source, options?.passthrough);
    const sanitized = {};
    for (const [key, value] of Object.entries(source)) {
        if (value === undefined)
            continue;
        const upper = key.toUpperCase();
        if (ALWAYS_BLOCKED_SUBPROCESS_ENV.has(upper))
            continue;
        if (isSensitiveEnvKey(key) && !allowlist.has(upper))
            continue;
        sanitized[key] = value;
    }
    return sanitized;
}
