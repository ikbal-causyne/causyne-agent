import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

export interface DetectedProviderConfig {
  provider: string;
  model: string;
  apiKey: string;
}

export type CausyneConfig = Record<string, any>;

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const FORBIDDEN_CONFIG_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function configDir(): string {
  return causyneHome();
}
function configFile(): string {
  return path.join(causyneHome(), 'config.json');
}
function keyFile(): string {
  return path.join(causyneHome(), '.vault_key');
}

function ensureConfigDir(): void {
  ensureVaultDir(configDir());
}

function encryptString(text: string): string {
  return encryptVaultSecret(text, keyFile());
}

function decryptString(encryptedText: string): string {
  return decryptVaultSecret(encryptedText, keyFile());
}

export function loadConfig(): CausyneConfig {
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
      const parsedRaw: unknown = JSON.parse(rawText);
      if (!parsedRaw || typeof parsedRaw !== 'object' || Array.isArray(parsedRaw)) {
        throw new Error('config.json must contain a JSON object');
      }
      const parsed = parsedRaw as CausyneConfig;
      let needsEncryptedResave = false;
      let hadDecryptFailure = false;

      if (typeof parsed.apiKey === 'string' && parsed.apiKey) {
        if (!isEncryptedVaultSecret(parsed.apiKey)) {
          needsEncryptedResave = true;
        } else {
          const decrypted = decryptString(parsed.apiKey);
          if (!decrypted) hadDecryptFailure = true;
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
            } else {
              const decrypted = decryptString(keyVal);
              if (!decrypted) hadDecryptFailure = true;
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
          if (!hadDecryptFailure) saveConfig(parsed);
        }
      }

      if ((parsed.provider === 'dashscope' || parsed.provider === 'dashscope-byok') && !parsed.apiKey && !hadDecryptFailure) {
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
    } catch (e: unknown) {
      console.error('Error reading config.json:', e);
    }
  }

  const envDetected = detectEnvironmentProvider();
  const defaultConfig: CausyneConfig = {
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

function readEnvSecret(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function detectEnvironmentProvider(): DetectedProviderConfig | null {
  const env = process.env;
  const geminiKey = readEnvSecret(env.GEMINI_API_KEY) || readEnvSecret(env.GOOGLE_API_KEY);
  if (geminiKey) {
    return {
      provider: 'gemini',
      apiKey: geminiKey,
      model: DEFAULT_MODEL_BY_PROVIDER.gemini || ''
    };
  }
  const anthropicKey = readEnvSecret(env.ANTHROPIC_API_KEY);
  if (anthropicKey) {
    return {
      provider: 'anthropic',
      apiKey: anthropicKey,
      model: DEFAULT_MODEL_BY_PROVIDER.anthropic || ''
    };
  }
  const openaiKey = readEnvSecret(env.OPENAI_API_KEY);
  if (openaiKey) {
    return {
      provider: 'openai',
      apiKey: openaiKey,
      model: DEFAULT_MODEL_BY_PROVIDER.openai || ''
    };
  }
  const deepseekKey = readEnvSecret(env.DEEPSEEK_API_KEY);
  if (deepseekKey) {
    return {
      provider: 'deepseek',
      apiKey: deepseekKey,
      model: DEFAULT_MODEL_BY_PROVIDER.deepseek || ''
    };
  }
  const xaiKey = readEnvSecret(env.XAI_API_KEY) || readEnvSecret(env.GROK_API_KEY);
  if (xaiKey) {
    return {
      provider: 'xai',
      apiKey: xaiKey,
      model: DEFAULT_MODEL_BY_PROVIDER.xai || ''
    };
  }
  const moonshotKey = readEnvSecret(env.MOONSHOT_API_KEY);
  if (moonshotKey) {
    return {
      provider: 'moonshot',
      apiKey: moonshotKey,
      model: DEFAULT_MODEL_BY_PROVIDER.moonshot || ''
    };
  }
  const dashscopeKey = readEnvSecret(env.DASHSCOPE_API_KEY) || readEnvSecret(env.QWEN_API_KEY);
  if (dashscopeKey) {
    return {
      provider: 'dashscope-byok',
      apiKey: dashscopeKey,
      model: DEFAULT_MODEL_BY_PROVIDER['dashscope-byok'] || ''
    };
  }

  return detectLocalAgentProvider();
}

function checkBinarySync(binaryName: string): boolean {
  if (typeof binaryName !== 'string' || !binaryName.trim() || /[\r\n\0]/.test(binaryName)) {
    return false;
  }
  const trimmed = binaryName.trim();
  if (path.isAbsolute(trimmed)) {
    try {
      if (!fs.statSync(trimmed).isFile()) return false;
      if (process.platform !== 'win32') fs.accessSync(trimmed, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) {
    return false;
  }
  const envPath = process.env.PATH || process.env.Path || '';
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

  for (const rawDir of dirs) {
    const dir = rawDir.trim();
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const ext of extensions) {
      const full = path.join(dir, `${trimmed}${ext}`);
      try {
        if (fs.statSync(full).isFile()) {
          if (process.platform !== 'win32') fs.accessSync(full, fs.constants.X_OK);
          return true;
        }
      } catch {
        // ignore inaccessible or non-executable entry
      }
    }
  }
  return false;
}

export function detectLocalAgentProvider(): DetectedProviderConfig | null {
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

export function saveConfig(config: CausyneConfig): void {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('saveConfig requires a plain configuration object');
  }
  ensureConfigDir();
  const configToSave = JSON.parse(JSON.stringify(config)) as CausyneConfig;
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
