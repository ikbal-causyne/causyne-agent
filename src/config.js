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

      // Self-heal a model id written before src/modelIds.js existed. The
      // provider normalises too, but tokenTracker.getPricing() and the /model
      // display both read config.model directly —
      // they must agree with what is actually sent, not with what a stale
      // Android build once wrote here.
      const canonicalModel = canonicalModelId(parsed.model);
      if (canonicalModel !== parsed.model) {
        parsed.model = canonicalModel;
        saveConfig(parsed);
      }

      return parsed;
    } catch (e) {
      console.error('Error reading config.json:', e);
    }
  }
  
    // Default config
  const defaultConfig = {
    provider: 'dashscope',
    // From the catalogue, not repeated here — this had been left at the
    // long-retired `qwen-plus` while the picker had moved to qwen3.7.
    model: DEFAULT_MODEL_BY_PROVIDER.dashscope,
    apiKey: '',
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
