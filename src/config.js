import fs from 'fs';
import path from 'path';
import { canonicalModelId } from './modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from './modelCatalogue.js';
import { causyneHome } from './utils/paths.js';
import {
  ensureVaultDir,
  atomicWriteSecretFileSync,
  encryptVaultSecret,
  decryptVaultSecret,
  isEncryptedVaultSecret
} from './configVault.js';

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
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      let needsEncryptedResave = false;

      // Decrypt API key into memory; flag legacy plaintext keys for immediate encrypted re-save.
      if (typeof parsed.apiKey === 'string' && parsed.apiKey) {
        if (!isEncryptedVaultSecret(parsed.apiKey)) {
          needsEncryptedResave = true;
        } else {
          parsed.apiKey = decryptString(parsed.apiKey);
        }
      }

      // Decrypt provider-specific API keys if stored; also re-encrypt any legacy plaintext entries.
      if (parsed.providerKeys && typeof parsed.providerKeys === 'object') {
        for (const [provider, keyVal] of Object.entries(parsed.providerKeys)) {
          if (typeof keyVal === 'string' && keyVal) {
            if (!isEncryptedVaultSecret(keyVal)) {
              needsEncryptedResave = true;
            } else {
              parsed.providerKeys[provider] = decryptString(keyVal);
            }
          }
        }
      }

      if (needsEncryptedResave) {
        saveConfig(parsed);
      }

      if (parsed.apiKey && parsed.provider) {
        parsed.providerKeys = parsed.providerKeys || {};
        if (!parsed.providerKeys[parsed.provider]) {
          parsed.providerKeys[parsed.provider] = parsed.apiKey;
        }
      }

      // Self-heal a model id written before src/modelIds.js existed.
      const canonicalModel = canonicalModelId(parsed.model);
      if (canonicalModel !== parsed.model) {
        parsed.model = canonicalModel;
        saveConfig(parsed);
      }

      // Self-heal legacy unconfigured DashScope bug:
      // If config was written with provider 'dashscope' or 'dashscope-byok' but without an apiKey,
      // it was an unintended default from older builds. Heal to an environment key (in-memory only,
      // never persisting transient env secrets to disk) or unconfigured.
      if ((parsed.provider === 'dashscope' || parsed.provider === 'dashscope-byok') && !parsed.apiKey) {
        const envDetected = detectEnvironmentProvider();
        if (envDetected && envDetected.apiKey) {
          parsed.provider = envDetected.provider;
          parsed.model = envDetected.model;
          parsed.apiKey = envDetected.apiKey;
        } else if (envDetected) {
          parsed.provider = envDetected.provider;
          parsed.model = envDetected.model;
          saveConfig(parsed);
        } else {
          parsed.provider = '';
          parsed.model = '';
          saveConfig(parsed);
        }
      }

      return parsed;
    } catch (e) {
      console.error('Error reading config.json:', e);
    }
  }
  
  // Default config: auto-detect from environment if available, otherwise unconfigured.
  // Transient environment API keys stay strictly in memory and are NEVER persisted to disk.
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
      maxCostUsd: 5.00, // Hard stop if cost exceeds this in BYOK mode
      warningThreshold: 0.8,
      hardStop: true
    }
  };
  if (!envDetected || !envDetected.apiKey) {
    saveConfig(defaultConfig);
  }
  return defaultConfig;
}

/**
 * Auto-detect available API keys from environment variables.
 * Precedence matches frontier capability: Gemini, Anthropic, OpenAI, DeepSeek, xAI, Moonshot, Qwen/DashScope.
 */
export function detectEnvironmentProvider() {
  const env = process.env;
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) {
    return {
      provider: 'gemini',
      apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '',
      model: DEFAULT_MODEL_BY_PROVIDER.gemini
    };
  }
  if (env.ANTHROPIC_API_KEY) {
    return {
      provider: 'anthropic',
      apiKey: env.ANTHROPIC_API_KEY,
      model: DEFAULT_MODEL_BY_PROVIDER.anthropic
    };
  }
  if (env.OPENAI_API_KEY) {
    return {
      provider: 'openai',
      apiKey: env.OPENAI_API_KEY,
      model: DEFAULT_MODEL_BY_PROVIDER.openai
    };
  }
  if (env.DEEPSEEK_API_KEY) {
    return {
      provider: 'deepseek',
      apiKey: env.DEEPSEEK_API_KEY,
      model: DEFAULT_MODEL_BY_PROVIDER.deepseek
    };
  }
  if (env.XAI_API_KEY || env.GROK_API_KEY) {
    return {
      provider: 'xai',
      apiKey: env.XAI_API_KEY || env.GROK_API_KEY || '',
      model: DEFAULT_MODEL_BY_PROVIDER.xai
    };
  }
  if (env.MOONSHOT_API_KEY) {
    return {
      provider: 'moonshot',
      apiKey: env.MOONSHOT_API_KEY,
      model: DEFAULT_MODEL_BY_PROVIDER.moonshot
    };
  }
  if (env.DASHSCOPE_API_KEY || env.QWEN_API_KEY) {
    return {
      provider: 'dashscope-byok',
      apiKey: env.DASHSCOPE_API_KEY || env.QWEN_API_KEY || '',
      model: DEFAULT_MODEL_BY_PROVIDER['dashscope-byok']
    };
  }

  // If no environment API keys found, auto-detect installed local sovereign agents
  return detectLocalAgentProvider();
}

function checkBinarySync(binaryName) {
  if (path.isAbsolute(binaryName)) {
    return fs.existsSync(binaryName);
  }
  const envPath = process.env.PATH || '';
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const home = process.env.HOME || '';
  const fallbackDirs = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.antigravity', 'antigravity', 'bin'),
    path.join(home, '.gemini', 'antigravity-ide', 'bin'),
    path.join(home, '.opencode', 'bin'),
    '/Applications/Antigravity.app/Contents/Resources/app/bin',
    '/Applications/Antigravity IDE.app/Contents/Resources/app/bin'
  ];
  const dirs = [...envPath.split(delimiter), ...fallbackDirs];
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];

  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of extensions) {
      const full = path.join(dir, `${binaryName}${ext}`);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          return true;
        }
      } catch {}
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
      model: DEFAULT_MODEL_BY_PROVIDER['acp/opencode'],
      apiKey: ''
    };
  }
  if (checkBinarySync('claude')) {
    return {
      provider: 'acp/claude',
      model: DEFAULT_MODEL_BY_PROVIDER['acp/claude'],
      apiKey: ''
    };
  }
  if (checkBinarySync('codex')) {
    return {
      provider: 'acp/codex',
      model: DEFAULT_MODEL_BY_PROVIDER['acp/codex'],
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
  ensureConfigDir();
  // SECURITY: Deep copy to avoid mutating the in-memory config
  const configToSave = JSON.parse(JSON.stringify(config));
  if (configToSave.apiKey) {
    configToSave.apiKey = encryptString(configToSave.apiKey);
  }
  if (configToSave.providerKeys && typeof configToSave.providerKeys === 'object') {
    for (const [provider, keyVal] of Object.entries(configToSave.providerKeys)) {
      if (typeof keyVal === 'string' && keyVal) {
        configToSave.providerKeys[provider] = encryptString(keyVal);
      }
    }
  }

  // SECURITY: Config file contains encrypted keys, written atomically with 0600 permissions
  const file = configFile();
  atomicWriteSecretFileSync(file, JSON.stringify(configToSave, null, 2));
}
