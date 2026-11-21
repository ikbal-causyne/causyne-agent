import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalModelId } from './modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from './modelCatalogue.js';
import { causyneHome } from './utils/paths.js';
import { ensureVaultDir, atomicWriteSecretFileSync, encryptVaultSecret, decryptVaultSecret, isEncryptedVaultSecret } from './configVault.js';
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const FORBIDDEN_CONFIG_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function configDir() {
    return causyneHome();
}
function configFile() {
    return path.join(causyneHome(), 'config.json');
}
function keyFile() {
    return path.join(causyneHome(), '.vault_key');
}
function ensureConfigDir() {
    ensureVaultDir(configDir());
}
function encryptString(text) {
    return encryptVaultSecret(text, keyFile());
}
function decryptString(encryptedText) {
    return decryptVaultSecret(encryptedText, keyFile());
}
export function loadConfig() {
    ensureConfigDir();
    const file = configFile();
    const hadExistingFile = fs.existsSync(file);
    if (hadExistingFile) {
        try {
            const stat = fs.lstatSync(file);
            if (stat.isSymbolicLink() || !stat.isFile()) {
                throw new Error('Refusing to load symlink or non-regular config.json');
            }
            if (stat.size > MAX_CONFIG_BYTES) {
                throw new Error(`config.json exceeds maximum size (${MAX_CONFIG_BYTES} bytes)`);
            }
            const rawText = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
            const parsedRaw = JSON.parse(rawText);
            if (!parsedRaw || typeof parsedRaw !== 'object' || Array.isArray(parsedRaw)) {
                throw new Error('config.json must contain a JSON object');
            }
            const parsed = parsedRaw;
            let needsEncryptedResave = false;
            let hadDecryptFailure = false;
            if (typeof parsed.apiKey === 'string' && parsed.apiKey) {
                if (!isEncryptedVaultSecret(parsed.apiKey)) {
                    needsEncryptedResave = true;
                }
                else {
                    const decrypted = decryptString(parsed.apiKey);
                    if (!decrypted)
                        hadDecryptFailure = true;
                    parsed.apiKey = decrypted;
                }
            }
            if (parsed.providerKeys && typeof parsed.providerKeys === 'object' && !Array.isArray(parsed.providerKeys)) {
                for (const [provider, keyVal] of Object.entries(parsed.providerKeys)) {
                    if (FORBIDDEN_CONFIG_KEYS.has(provider)) {
                        delete parsed.providerKeys[provider];
                        continue;
                    }
                    if (typeof keyVal === 'string' && keyVal) {
                        if (!isEncryptedVaultSecret(keyVal)) {
                            needsEncryptedResave = true;
                        }
                        else {
                            const decrypted = decryptString(keyVal);
                            if (!decrypted)
                                hadDecryptFailure = true;
                            parsed.providerKeys[provider] = decrypted;
                        }
                    }
                }
            }
            if (needsEncryptedResave && !hadDecryptFailure) {
                saveConfig(parsed);
            }
            if (parsed.apiKey && parsed.provider) {
                parsed.providerKeys = parsed.providerKeys || {};
                if (!parsed.providerKeys[parsed.provider]) {
                    parsed.providerKeys[parsed.provider] = parsed.apiKey;
                }
            }
            if (typeof parsed.model === 'string' && parsed.model.trim()) {
                const canonicalModel = canonicalModelId(parsed.model);
                if (canonicalModel !== parsed.model) {
                    parsed.model = canonicalModel;
                    if (!hadDecryptFailure)
                        saveConfig(parsed);
                }
            }
            if ((parsed.provider === 'dashscope' || parsed.provider === 'dashscope-byok') && !parsed.apiKey && !hadDecryptFailure) {
                const envDetected = detectEnvironmentProvider();
                if (envDetected && envDetected.apiKey) {
                    parsed.provider = envDetected.provider;
                    parsed.model = envDetected.model;
                    parsed.apiKey = envDetected.apiKey;
                }
                else if (envDetected) {
                    parsed.provider = envDetected.provider;
                    parsed.model = envDetected.model;
                    saveConfig(parsed);
                }
                else {
                    parsed.provider = '';
                    parsed.model = '';
                    saveConfig(parsed);
                }
            }
            return parsed;
        }
        catch (e) {
            console.error('Error reading config.json:', e);
        }
    }
    const envDetected = detectEnvironmentProvider();
    const defaultConfig = {
        provider: envDetected ? envDetected.provider : '',
        model: envDetected ? envDetected.model : '',
        apiKey: envDetected ? envDetected.apiKey : '',
        autonomyMode: 'B',
        tokenBudget: {
            enabled: false,
            maxTokensPerTask: 500000,
            maxTokensPerDay: 2000000,
            maxCostUsd: 5.00,
            warningThreshold: 0.8,
            hardStop: true
        }
    };
    if (!hadExistingFile && (!envDetected || !envDetected.apiKey)) {
        saveConfig(defaultConfig);
    }
    return defaultConfig;
}
export function detectEnvironmentProvider() {
    const env = process.env;
    if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) {
        return {
            provider: 'gemini',
            apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '',
            model: DEFAULT_MODEL_BY_PROVIDER.gemini || ''
        };
    }
    if (env.ANTHROPIC_API_KEY) {
        return {
            provider: 'anthropic',
            apiKey: env.ANTHROPIC_API_KEY,
            model: DEFAULT_MODEL_BY_PROVIDER.anthropic || ''
        };
    }
    if (env.OPENAI_API_KEY) {
        return {
            provider: 'openai',
            apiKey: env.OPENAI_API_KEY,
            model: DEFAULT_MODEL_BY_PROVIDER.openai || ''
        };
    }
    if (env.DEEPSEEK_API_KEY) {
        return {
            provider: 'deepseek',
            apiKey: env.DEEPSEEK_API_KEY,
            model: DEFAULT_MODEL_BY_PROVIDER.deepseek || ''
        };
    }
    if (env.XAI_API_KEY || env.GROK_API_KEY) {
        return {
            provider: 'xai',
            apiKey: env.XAI_API_KEY || env.GROK_API_KEY || '',
            model: DEFAULT_MODEL_BY_PROVIDER.xai || ''
        };
    }
    if (env.MOONSHOT_API_KEY) {
        return {
            provider: 'moonshot',
            apiKey: env.MOONSHOT_API_KEY,
            model: DEFAULT_MODEL_BY_PROVIDER.moonshot || ''
        };
    }
    if (env.DASHSCOPE_API_KEY || env.QWEN_API_KEY) {
        return {
            provider: 'dashscope-byok',
            apiKey: env.DASHSCOPE_API_KEY || env.QWEN_API_KEY || '',
            model: DEFAULT_MODEL_BY_PROVIDER['dashscope-byok'] || ''
        };
    }
    return detectLocalAgentProvider();
}
function checkBinarySync(binaryName) {
    if (path.isAbsolute(binaryName)) {
        return fs.existsSync(binaryName);
    }
    const envPath = process.env.PATH || '';
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
    const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
    for (const dir of dirs) {
        if (!dir)
            continue;
        for (const ext of extensions) {
            const full = path.join(dir, `${binaryName}${ext}`);
            try {
                if (fs.existsSync(full) && fs.statSync(full).isFile()) {
                    return true;
                }
            }
            catch {
                // ignore inaccessible entry
            }
        }
    }
    return false;
}
export function detectLocalAgentProvider() {
    if (checkBinarySync('agy') || checkBinarySync('antigravity')) {
        return {
            provider: 'antigravity',
            model: DEFAULT_MODEL_BY_PROVIDER.antigravity || 'Gemini 3.8 Flash (Low)',
            apiKey: ''
        };
    }
    if (checkBinarySync('opencode')) {
        return {
            provider: 'acp/opencode',
            model: DEFAULT_MODEL_BY_PROVIDER['acp/opencode'] || '',
            apiKey: ''
        };
    }
    if (checkBinarySync('claude')) {
        return {
            provider: 'acp/claude',
            model: DEFAULT_MODEL_BY_PROVIDER['acp/claude'] || '',
            apiKey: ''
        };
    }
    if (checkBinarySync('codex')) {
        return {
            provider: 'acp/codex',
            model: DEFAULT_MODEL_BY_PROVIDER['acp/codex'] || '',
            apiKey: ''
        };
    }
    if (checkBinarySync('ollama')) {
        return {
            provider: 'ollama',
            model: DEFAULT_MODEL_BY_PROVIDER.ollama || 'llama3.3',
            apiKey: ''
        };
    }
    return null;
}
export function saveConfig(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('saveConfig requires a plain configuration object');
    }
    ensureConfigDir();
    const configToSave = JSON.parse(JSON.stringify(config));
    if (typeof configToSave.apiKey === 'string' && configToSave.apiKey) {
        configToSave.apiKey = encryptString(configToSave.apiKey);
    }
    if (configToSave.providerKeys && typeof configToSave.providerKeys === 'object' && !Array.isArray(configToSave.providerKeys)) {
        for (const [provider, keyVal] of Object.entries(configToSave.providerKeys)) {
            if (FORBIDDEN_CONFIG_KEYS.has(provider)) {
                delete configToSave.providerKeys[provider];
                continue;
            }
            if (typeof keyVal === 'string' && keyVal) {
                configToSave.providerKeys[provider] = encryptString(keyVal);
            }
        }
    }
    const file = configFile();
    atomicWriteSecretFileSync(file, JSON.stringify(configToSave, null, 2));
}
