import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { canonicalModelId } from './modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from './modelCatalogue.js';
import { causyneHome } from './utils/paths.js';

const CONFIG_DIR = causyneHome();
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const KEY_FILE = path.join(CONFIG_DIR, '.vault_key');

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    // SECURITY: Directory must only be accessible by the owner
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

function getVaultKey() {
  ensureConfigDir();
  if (!fs.existsSync(KEY_FILE)) {
    const key = crypto.randomBytes(32);
    fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
    return key;
  }
  return fs.readFileSync(KEY_FILE);
}

function encryptString(text) {
  if (!text) return text;
  if (text.startsWith('ENC:')) return text; // Already encrypted
  const key = getVaultKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `ENC:${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decryptString(encryptedText) {
  if (!encryptedText || !encryptedText.startsWith('ENC:')) return encryptedText;
  try {
    const parts = encryptedText.split(':');
    if (parts.length !== 4) return '';
    const iv = Buffer.from(parts[1], 'hex');
    const authTag = Buffer.from(parts[2], 'hex');
    const encrypted = parts[3];
    const key = getVaultKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    console.error('Failed to decrypt API key:', e);
    return '';
  }
}

export function loadConfig() {
  ensureConfigDir();
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      
      // Decrypt API key into memory
      if (parsed.apiKey) {
        if (!parsed.apiKey.startsWith('ENC:')) {
          // Found legacy plaintext key. We must encrypt it and re-save immediately.
          const plaintext = parsed.apiKey;
          parsed.apiKey = encryptString(plaintext);
          saveConfig(parsed); // Re-saves safely encrypted
          parsed.apiKey = plaintext; // Keep plaintext in memory for this session
        } else {
          parsed.apiKey = decryptString(parsed.apiKey);
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
      // it was an unintended default from older builds. Heal to an environment key or unconfigured.
      if ((parsed.provider === 'dashscope' || parsed.provider === 'dashscope-byok') && !parsed.apiKey) {
        const envDetected = detectEnvironmentProvider();
        if (envDetected) {
          parsed.provider = envDetected.provider;
          parsed.model = envDetected.model;
          parsed.apiKey = envDetected.apiKey;
        } else {
          parsed.provider = '';
          parsed.model = '';
        }
        saveConfig(parsed);
      }

      return parsed;
    } catch (e) {
      console.error('Error reading config.json:', e);
    }
  }
  
  // Default config: auto-detect from environment if available, otherwise unconfigured
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
  saveConfig(defaultConfig);
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

  // SECURITY: Config file contains encrypted keys, must be 0600 (owner read/write only)
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(configToSave, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(CONFIG_FILE, 0o600); // Enforce on existing files
}
