import fs from 'node:fs';
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
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as CausyneConfig;
      let needsEncryptedResave = false;

      if (typeof parsed.apiKey === 'string' && parsed.apiKey) {
        if (!isEncryptedVaultSecret(parsed.apiKey)) {
          needsEncryptedResave = true;
        } else {
          parsed.apiKey = decryptString(parsed.apiKey);
        }
      }

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

      const canonicalModel = canonicalModelId(parsed.model);
      if (canonicalModel !== parsed.model) {
        parsed.model = canonicalModel;
        saveConfig(parsed);
      }

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
  if (!envDetected || !envDetected.apiKey) {
    saveConfig(defaultConfig);
  }
  return defaultConfig;
}

export function detectEnvironmentProvider(): DetectedProviderConfig | null {
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

function checkBinarySync(binaryName: string): boolean {
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
      } catch {
        // ignore inaccessible entry
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
  ensureConfigDir();
  const configToSave = JSON.parse(JSON.stringify(config)) as CausyneConfig;
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

  const file = configFile();
  atomicWriteSecretFileSync(file, JSON.stringify(configToSave, null, 2));
}
