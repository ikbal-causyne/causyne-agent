// Sovereign Dynamic Model Architecture & Live Discovery
//
// WHY THIS EXISTS:
// AI providers release and update models continuously. Hardcoded static
// catalogues freeze models at build time. This module gives Causyne a dual-layer
// model architecture:
//   1. Curated baseline: Instant offline availability with zero latency and verified pricing/capability tiers.
//   2. Dynamic discovery: Live discovery via provider APIs (Ollama, OpenAI, Gemini, Anthropic, DeepSeek, etc.)
//      with resilient local caching in ~/.causyne/models_cache.json.
//
// ZERO-MALWARE: Pure TypeScript/ESM. Strictly respects timeouts, no secret leakage, no unprompted background calls.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { causyneHome } from './utils/paths.js';
import { MODEL_CATALOGUE, PEER_MODEL_CATALOGUE, DEFAULT_MODEL_BY_PROVIDER } from './modelCatalogue.js';
import {
  BASELINE_ANTIGRAVITY_MODELS,
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_MODEL_IDS,
  ANTIGRAVITY_LABEL_BY_ID,
  registerAntigravityModel,
  replaceAntigravityModels,
  parseAgyModelsOutput,
  isAntigravityOnboarded,
  resolveAgyBinary
} from './providers/antigravity.js';
import {
  isBinaryOnPath,
  BUILTIN_PEER_PRESETS,
  probePresetAuth,
  testPeerHandshake
} from './acp/agentCatalog.js';
import { getPeerProfile } from './acp/peerProfiles.js';

const execFileAsync = promisify(execFile);

export interface DynamicCatalogueCacheEntry {
  timestamp: number;
  models: string[];
  fingerprint?: string | undefined;
  currentModel?: string | undefined;
  modelIdMap?: Record<string, string> | undefined;
}

export interface DynamicCatalogueCache {
  version: 1;
  updatedAt: string;
  providers: Record<string, DynamicCatalogueCacheEntry>;
}

const BYOK_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour for cloud API model lists
const PEER_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes for fluctuating local/ACP peer tiers
const REQUEST_TIMEOUT_MS = 3500; // Fast timeout to never block user interaction

export function cacheFilePath(): string {
  return path.join(causyneHome(), 'models_cache.json');
}

export function normalizeProviderKey(provider: string): string {
  const p = (provider || '').toLowerCase().trim();
  if (p === 'dashscope' || p === 'dashscope-byok' || p === 'alibaba') return 'dashscope-byok';
  if (p === 'ollama') return 'ollama';
  if (p === 'openai') return 'openai';
  if (p === 'anthropic' || p === 'claude') return 'anthropic';
  if (p === 'gemini' || p === 'google') return 'gemini';
  if (p === 'deepseek') return 'deepseek';
  if (p === 'xai' || p === 'grok') return 'xai';
  if (p === 'moonshot' || p === 'kimi') return 'moonshot';
  if (p === 'muse' || p === 'meta') return 'muse';
  if (p === 'openai-compatible' || p === 'custom') return 'openai-compatible';
  if (p === 'antigravity' || p === 'agy') return 'antigravity';
  if (p === 'acp') return 'acp';
  if (p.startsWith('acp/')) {
    const peer = p.slice(4).split('/')[0];
    return peer ? `acp/${peer}` : 'acp';
  }
  return p;
}

/**
 * The peer id behind an `acp/<peer>` provider key, or null.
 *
 * Peer agents are providers in exactly the same sense as an HTTP API: the user
 * already owns the credential (their CLI login), and the models available are
 * whatever that account can reach. The provider key carries the peer so the
 * catalogue, the cache and the picker cannot disagree about which one is meant.
 */
export function peerIdFromProviderKey(provider: string): string | null {
  const p = (provider || '').toLowerCase().trim();
  if (!p.startsWith('acp/')) return null;
  const peer = p.slice(4).split('/')[0];
  return peer || null;
}

/** Get the static curated baseline models for a provider id (offline fallback). */
export function getCuratedModels(provider: string): string[] {
  const norm = normalizeProviderKey(provider);
  if (norm === 'antigravity') return Object.keys(BASELINE_ANTIGRAVITY_MODELS);
  if (norm === 'pi') return [...(MODEL_CATALOGUE['Pi (Local Peer)'] || ['default'])];
  const peer = peerIdFromProviderKey(norm);
  if (peer) return [...(PEER_MODEL_CATALOGUE[peer] ?? [])];
  if (norm === 'acp') return [...(MODEL_CATALOGUE['ACP (Peer Agents)'] ?? [])];
  const mapping: Record<string, keyof typeof MODEL_CATALOGUE> = {
    'deepseek': 'DeepSeek',
    'qwen': 'Qwen',
    'dashscope-byok': 'Alibaba (DashScope)',
    'dashscope': 'Alibaba (DashScope)',
    'anthropic': 'Anthropic',
    'openai': 'OpenAI',
    'gemini': 'Gemini',
    'muse': 'Meta (Muse)',
    'ollama': 'Ollama (Local)',
    'moonshot': 'Moonshot (Kimi)',
    'xai': 'xAI (Grok)'
  };
  const key = mapping[norm];
  if (key && MODEL_CATALOGUE[key]) {
    return [...MODEL_CATALOGUE[key]];
  }
  return [];
}

function isLocalOrAcpProvider(norm: string): boolean {
  return norm === 'antigravity' || norm === 'pi' || norm === 'acp' || peerIdFromProviderKey(norm) !== null;
}

function statSignature(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) return 'missing';
    const stat = fs.statSync(filePath);
    return `${Math.floor(stat.mtimeMs)}:${stat.size}`;
  } catch {
    return 'err';
  }
}

/**
 * Compute a fast, non-secret fingerprint of a provider's local auth/account/config state.
 * When a user switches accounts, upgrades tiers (e.g. Starter -> Pro -> Ultra), or edits
 * their CLI settings, the fingerprint changes and invalidates stale cached models immediately.
 */
export function computeProviderAuthFingerprint(
  provider: string,
  config: { apiKey?: string; baseUrl?: string; providerKeys?: Record<string, string> } = {}
): string {
  const norm = normalizeProviderKey(provider);
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const parts: string[] = [norm];

  if (norm === 'antigravity') {
    parts.push(
      statSignature(path.join(home, '.gemini', 'oauth_creds.json')),
      statSignature(path.join(home, '.gemini', 'google_accounts.json')),
      statSignature(path.join(home, '.gemini', 'antigravity-cli', 'settings.json')),
      statSignature(path.join(home, '.gemini', 'antigravity-cli', 'cache', 'onboarding.json'))
    );
  } else if (norm === 'pi') {
    parts.push(
      statSignature(path.join(home, '.pi', 'agent', 'models.json')),
      statSignature(path.join(home, '.pi', 'agent', 'auth.json')),
      statSignature(path.join(home, '.pi', 'agent', 'settings.json')),
      statSignature(path.join(home, '.config', 'pi', 'config.json'))
    );
  } else if (peerIdFromProviderKey(norm)) {
    const peer = peerIdFromProviderKey(norm)!;
    const peerFiles: Record<string, string[]> = {
      opencode: [
        path.join(home, '.config', 'opencode', 'opencode.json'),
        path.join(home, '.config', 'opencode', 'config.json'),
        path.join(home, '.local', 'share', 'opencode', 'auth.json'),
        path.join(home, '.opencode', 'config.json')
      ],
      claude: [
        path.join(home, '.claude', 'settings.json'),
        path.join(home, '.claude.json'),
        path.join(home, '.config', 'claude', 'config.json')
      ],
      codex: [
        path.join(home, '.codex', 'auth.json'),
        path.join(home, '.codex', 'config.toml'),
        path.join(home, '.codex', 'config.json')
      ],
      gemini: [
        path.join(home, '.gemini', 'oauth_creds.json'),
        path.join(home, '.gemini', 'google_accounts.json'),
        path.join(home, '.gemini', 'settings.json')
      ],
      cursor: [
        path.join(home, '.cursor', 'cli-config.json'),
        path.join(home, '.config', 'cursor', 'auth.json')
      ],
      qwen: [
        path.join(home, '.qwen', 'oauth_creds.json'),
        path.join(home, '.qwen', 'settings.json')
      ],
      copilot: [
        path.join(home, '.config', 'github-copilot', 'hosts.json'),
        path.join(home, '.config', 'github-copilot', 'apps.json')
      ],
      kimi: [
        path.join(home, '.kimi', 'config.toml'),
        path.join(home, '.kimi', 'config.json')
      ],
      goose: [
        path.join(home, '.config', 'goose', 'config.yaml'),
        path.join(home, '.config', 'goose', 'profiles.yaml')
      ],
      hermes: [
        path.join(home, '.hermes', 'config.yaml'),
        path.join(home, '.hermes', 'config.json')
      ]
    };
    for (const file of peerFiles[peer] || []) {
      parts.push(statSignature(file));
    }
    if (peer === 'claude') {
      parts.push(process.env.ANTHROPIC_MODEL || '', process.env.CLAUDE_MODEL || '', String(Boolean(process.env.ANTHROPIC_API_KEY)));
    } else if (peer === 'codex') {
      parts.push(process.env.OPENAI_MODEL || '', String(Boolean(process.env.OPENAI_API_KEY)));
    } else if (peer === 'gemini') {
      parts.push(process.env.GEMINI_MODEL || '', String(Boolean(process.env.GEMINI_API_KEY)));
    }
  } else {
    const key = config.apiKey || (config.providerKeys && config.providerKeys[norm]) || '';
    const keyDigest = key ? crypto.createHash('sha256').update(key).digest('hex').slice(0, 12) : 'nokey';
    parts.push(keyDigest, config.baseUrl || '');
  }

  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

export interface ByokProviderInfo {
  id: string;
  label: string;
  isConfigured: boolean;
  isCurrent: boolean;
  models: string[];
  defaultModel: string;
  envVar?: string | undefined;
}

export interface AcpPeerInfo {
  id: string;
  providerKey: string;
  label: string;
  installed: boolean;
  status: 'ready' | 'not_installed';
  isCurrent: boolean;
  command: string;
  models: string[];
  setupInstruction: string;
}

export interface ProviderOverview {
  activeProvider: string;
  activeModel: string;
  byok: ByokProviderInfo[];
  acp: AcpPeerInfo[];
}

/**
 * Categorize available providers into BYOK and ACP peer agents,
 * checking configured state for BYOK and installation status for ACP agents.
 */
export function getAvailableProvidersOverview(
  config: { provider?: string; apiKey?: string; model?: string; providerKeys?: Record<string, string> } = {}
): ProviderOverview {
  const currentProvider = config.provider || '';
  const currentModel = config.model || '';

  const byokDefs: Array<{ id: string; label: string; envVar?: string; defaultModel: string; models: string[] }> = [
    {
      id: 'anthropic',
      label: 'Anthropic',
      envVar: 'ANTHROPIC_API_KEY',
      defaultModel: DEFAULT_MODEL_BY_PROVIDER['anthropic'] || 'claude-3-7-sonnet',
      models: MODEL_CATALOGUE['Anthropic'] ? [...MODEL_CATALOGUE['Anthropic']] : []
    },
    {
      id: 'openai',
      label: 'OpenAI',
      envVar: 'OPENAI_API_KEY',
      defaultModel: DEFAULT_MODEL_BY_PROVIDER['openai'] || 'gpt-4o',
      models: MODEL_CATALOGUE['OpenAI'] ? [...MODEL_CATALOGUE['OpenAI']] : []
    },
    {
      id: 'gemini',
      label: 'Google Gemini',
      envVar: 'GEMINI_API_KEY',
      defaultModel: DEFAULT_MODEL_BY_PROVIDER['gemini'] || 'gemini-2.5-pro',
      models: MODEL_CATALOGUE['Gemini'] ? [...MODEL_CATALOGUE['Gemini']] : []
    },
    {
      id: 'deepseek',
      label: 'DeepSeek',
      envVar: 'DEEPSEEK_API_KEY',
      defaultModel: DEFAULT_MODEL_BY_PROVIDER['deepseek'] || 'deepseek-chat',
      models: MODEL_CATALOGUE['DeepSeek'] ? [...MODEL_CATALOGUE['DeepSeek']] : []
    },
    {
      id: 'qwen',
      label: 'Qwen / DashScope',
      envVar: 'DASHSCOPE_API_KEY',
      defaultModel: DEFAULT_MODEL_BY_PROVIDER['qwen'] || 'qwen2.5-coder-32b-instruct',
      models: MODEL_CATALOGUE['Qwen'] ? [...MODEL_CATALOGUE['Qwen']] : []
    },
    {
      id: 'ollama',
      label: 'Ollama (Local Server)',
      defaultModel: DEFAULT_MODEL_BY_PROVIDER['ollama'] || 'llama3.3',
      models: MODEL_CATALOGUE['Ollama (Local)'] ? [...MODEL_CATALOGUE['Ollama (Local)']] : []
    },
    {
      id: 'xai',
      label: 'xAI (Grok)',
      envVar: 'XAI_API_KEY',
      defaultModel: DEFAULT_MODEL_BY_PROVIDER['xai'] || 'grok-3',
      models: MODEL_CATALOGUE['xAI (Grok)'] ? [...MODEL_CATALOGUE['xAI (Grok)']] : []
    },
    {
      id: 'moonshot',
      label: 'Moonshot (Kimi)',
      envVar: 'MOONSHOT_API_KEY',
      defaultModel: DEFAULT_MODEL_BY_PROVIDER['moonshot'] || 'kimi-k3',
      models: MODEL_CATALOGUE['Moonshot (Kimi)'] ? [...MODEL_CATALOGUE['Moonshot (Kimi)']] : []
    }
  ];

  const byok: ByokProviderInfo[] = byokDefs.map((def) => {
    const isCurrent = currentProvider === def.id || (def.id === 'qwen' && currentProvider === 'dashscope-byok');
    const hasStoredKey = Boolean(isCurrent && config.apiKey)
      || Boolean(config.providerKeys && (config.providerKeys[def.id] || (def.id === 'qwen' && config.providerKeys['dashscope-byok'])))
      || Boolean(def.envVar && process.env[def.envVar]);
    const isConfigured = def.id === 'ollama' || hasStoredKey;
    const cachedByok = getCachedModels(def.id, config);
    const models = cachedByok && cachedByok.length > 0 ? [...cachedByok] : def.models;

    return {
      id: def.id,
      label: def.label,
      isConfigured,
      isCurrent,
      models,
      defaultModel: models[0] || def.defaultModel,
      envVar: def.envVar
    };
  });

  const acpPeers: AcpPeerInfo[] = [];

  // Antigravity (special native local provider)
  const hasAgy = Boolean(resolveAgyBinary());
  const cachedAgyModels = getCachedModels('antigravity', config);
  const agyModels = cachedAgyModels && cachedAgyModels.length > 0
    ? replaceAntigravityModels(cachedAgyModels)
    : [...ANTIGRAVITY_MODELS];
  acpPeers.push({
    id: 'antigravity',
    providerKey: 'antigravity',
    label: 'Google Antigravity (AGY)',
    installed: hasAgy,
    status: hasAgy ? 'ready' : 'not_installed',
    isCurrent: currentProvider === 'antigravity',
    command: 'agy --output-format json',
    models: agyModels,
    setupInstruction: 'Install Antigravity IDE or agy CLI to enable Google AGY models.'
  });

  const hasPi = isBinaryOnPath('pi');
  const cachedPiModels = getCachedModels('pi', config);
  const configPiModels = detectPeerConfigModels('pi');
  const piModels = (cachedPiModels && cachedPiModels.length > 0)
    ? [...cachedPiModels]
    : (configPiModels.length > 0 ? configPiModels : ['default']);
  acpPeers.push({
    id: 'pi', providerKey: 'pi', label: 'Pi coding agent',
    installed: hasPi, status: hasPi ? 'ready' : 'not_installed',
    isCurrent: currentProvider === 'pi', command: 'pi --mode rpc --no-tools',
    models: piModels,
    setupInstruction: 'Install Pi CLI and configure its model login before selecting it in Causyne.'
  });

  // Standard ACP presets
  const presetOrder = ['opencode', 'claude', 'codex', 'gemini', 'cursor', 'hermes', 'qwen', 'copilot', 'kimi', 'goose'];
  for (const presetId of presetOrder) {
    const preset = BUILTIN_PEER_PRESETS[presetId];
    if (!preset) continue;

    let installed = false;
    if (preset.id === 'cursor') {
      installed = isBinaryOnPath('cursor-agent') || isBinaryOnPath('cursor');
    } else {
      installed = isBinaryOnPath(preset.binaryName);
    }

    const providerKey = `acp/${preset.id}`;
    const isCurrent = currentProvider === providerKey;

    const cachedPeerModels = getCachedModels(providerKey, config) || getCachedModels(preset.id, config);
    const localConfigModels = detectPeerConfigModels(preset.id);
    let models: string[] = [];
    if (cachedPeerModels && cachedPeerModels.length > 0) {
      models = [...cachedPeerModels];
    } else if (preset.id === 'claude') {
      models = detectClaudeModels();
    } else if (localConfigModels.length > 0) {
      models = [...new Set([...localConfigModels, ...(PEER_MODEL_CATALOGUE[preset.id] || [])])];
    } else if (PEER_MODEL_CATALOGUE[preset.id]) {
      models = [...(PEER_MODEL_CATALOGUE[preset.id] || [])];
    } else if (DEFAULT_MODEL_BY_PROVIDER[providerKey]) {
      models = [DEFAULT_MODEL_BY_PROVIDER[providerKey]];
    } else {
      models = [preset.id];
    }

    // A saved preference is not evidence that the active peer still offers it.
    // Only retain it as a fallback when no fresh peer model list is cached.
    if (isCurrent && currentModel && !cachedPeerModels && !models.includes(currentModel)) {
      models = [currentModel, ...models];
    }

    acpPeers.push({
      id: preset.id,
      providerKey,
      label: preset.label,
      installed,
      status: installed ? 'ready' : 'not_installed',
      isCurrent,
      command: `${preset.command} ${preset.args.join(' ')}`,
      models,
      setupInstruction: preset.setupInstruction || `Install ${preset.label} CLI on your system.`
    });
  }

  return {
    activeProvider: currentProvider,
    activeModel: currentModel,
    byok,
    acp: acpPeers
  };
}

const MODEL_LIST_TIMEOUT_MS = 8000;
const ACP_DISCOVERY_TIMEOUT_MS = 4500;
const ANSI_ESCAPE = /\u001b\[[0-9;]*[A-Za-z]/g;

const PEER_MODEL_COMMANDS: Record<string, { command: string; args: string[] }> = {
  opencode: { command: 'opencode', args: ['models'] },
  cursor: { command: 'cursor-agent', args: ['models'] }
};

async function runModelList(command: string, args: string[]): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: MODEL_LIST_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, CI: '1', BROWSER: 'false', NO_BROWSER: '1' }
    });
    return stdout.replace(ANSI_ESCAPE, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function parseModelIds(lines: string[]): string[] {
  const models: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(ANSI_ESCAPE, '').trim();
    if (!line) continue;
    if (/^(fetching|loading|no models|error|warning|usage|available|use\s|see\s|run\s|help|models|provider\s+model|id\s+name|default|configured|login|please|note:|tip:|info:)/i.test(line)) {
      continue;
    }
    if (line.endsWith('…') || line.endsWith('...') || line.endsWith(':')) continue;
    if (/^(\/|~|\.|--|http:\/\/|https:\/\/)/i.test(line)) continue;
    const match = line.match(/^([a-z0-9][a-z0-9_.:/-]*)/i);
    if (match && match[1]) {
      const candidate = match[1].replace(/[.,;:]+$/, '');
      if (!candidate || candidate.length < 2) continue;
      if (/^(node_modules|provider|model|context|thinking|images|none|null|undefined)$/i.test(candidate)) continue;
      if (/\.(md|json|js|ts|yaml|yml|toml|txt|html)$/i.test(candidate)) continue;
      models.push(candidate);
    }
  }
  return [...new Set(models)];
}

export function parsePiModelsOutput(stdout: string): string[] {
  const models: string[] = [];
  if (!stdout || typeof stdout !== 'string') return models;
  const lines = stdout.replace(ANSI_ESCAPE, '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(no models|warning|error|use\s+\/login|see:|provider\s+model)/i.test(line)) continue;
    if (/^(\/|~|\.|http:\/\/|https:\/\/)/i.test(line)) continue;
    const cols = line.split(/\s{2,}/).map(c => c.trim()).filter(Boolean);
    if (cols.length >= 2) {
      const provider = cols[0]!;
      const model = cols[1]!;
      if (provider.toLowerCase() === 'provider' && model.toLowerCase() === 'model') continue;
      if (/^[a-z0-9_.-]+$/i.test(provider) && /^[a-z0-9_.:/-]+$/i.test(model)) {
        models.push(model.includes('/') ? model : `${provider}/${model}`);
      }
    }
  }
  return [...new Set(models)];
}

/**
 * Inspect local CLI configuration files (JSON/TOML/YAML) and environment variables
 * to discover user-configured models for a peer agent with zero process overhead.
 */
export function detectPeerConfigModels(peerId: string): string[] {
  const peer = (peerId || '').toLowerCase().trim();
  const models: string[] = [];
  const home = process.env.HOME || process.env.USERPROFILE || '';

  const addModel = (val: unknown): void => {
    if (typeof val === 'string' && val.trim()) {
      const clean = val.trim();
      if (!models.includes(clean)) models.push(clean);
    }
  };

  try {
    if (peer === 'claude') {
      if (home) {
        for (const rel of [['.claude', 'settings.json'], ['.claude.json'], ['.config', 'claude', 'settings.json']]) {
          const file = path.join(home, ...rel);
          if (fs.existsSync(file)) {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
            addModel(parsed?.model);
            addModel(parsed?.defaultModel);
            if (Array.isArray(parsed?.availableModels)) {
              for (const m of parsed.availableModels) addModel(m);
            }
          }
        }
      }
      addModel(process.env.ANTHROPIC_MODEL || process.env.CLAUDE_MODEL);
    } else if (peer === 'codex') {
      addModel(process.env.OPENAI_MODEL);
      if (home) {
        const tomlFile = path.join(home, '.codex', 'config.toml');
        if (fs.existsSync(tomlFile)) {
          const content = fs.readFileSync(tomlFile, 'utf8');
          for (const match of content.matchAll(/^\s*model\s*=\s*["']([^"']+)["']/gm)) {
            addModel(match[1]);
          }
        }
        const jsonFile = path.join(home, '.codex', 'config.json');
        if (fs.existsSync(jsonFile)) {
          const parsed = JSON.parse(fs.readFileSync(jsonFile, 'utf8')) as Record<string, unknown>;
          addModel(parsed?.model);
        }
      }
    } else if (peer === 'gemini') {
      addModel(process.env.GEMINI_MODEL);
      if (home) {
        const settingsFile = path.join(home, '.gemini', 'settings.json');
        if (fs.existsSync(settingsFile)) {
          const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, unknown>;
          addModel(parsed?.model);
          addModel(parsed?.selectedModel);
          if (Array.isArray(parsed?.availableModels)) {
            for (const m of parsed.availableModels) addModel(m);
          }
        }
      }
    } else if (peer === 'opencode') {
      if (home) {
        for (const file of [
          path.join(home, '.config', 'opencode', 'opencode.json'),
          path.join(home, '.config', 'opencode', 'config.json'),
          path.join(home, '.opencode', 'config.json')
        ]) {
          if (fs.existsSync(file)) {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
            addModel(parsed?.model);
            addModel(parsed?.small_model);
            if (parsed?.provider && typeof parsed.provider === 'object') {
              for (const [provId, provCfg] of Object.entries(parsed.provider as Record<string, unknown>)) {
                if (provCfg && typeof provCfg === 'object' && 'models' in provCfg) {
                  const modelsObj = (provCfg as Record<string, unknown>).models;
                  if (modelsObj && typeof modelsObj === 'object') {
                    for (const modelKey of Object.keys(modelsObj as Record<string, unknown>)) {
                      addModel(modelKey.includes('/') ? modelKey : `${provId}/${modelKey}`);
                    }
                  }
                }
              }
            }
          }
        }
      }
    } else if (peer === 'qwen') {
      if (home) {
        const settingsFile = path.join(home, '.qwen', 'settings.json');
        if (fs.existsSync(settingsFile)) {
          const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, unknown>;
          addModel(parsed?.model);
          if (Array.isArray(parsed?.availableModels)) {
            for (const m of parsed.availableModels) addModel(m);
          }
        }
      }
    } else if (peer === 'kimi') {
      if (home) {
        const tomlFile = path.join(home, '.kimi', 'config.toml');
        if (fs.existsSync(tomlFile)) {
          const content = fs.readFileSync(tomlFile, 'utf8');
          for (const match of content.matchAll(/^\s*(?:default_)?model\s*=\s*["']([^"']+)["']/gm)) {
            addModel(match[1]);
          }
        }
      }
    } else if (peer === 'goose') {
      if (home) {
        const yamlFile = path.join(home, '.config', 'goose', 'config.yaml');
        if (fs.existsSync(yamlFile)) {
          const content = fs.readFileSync(yamlFile, 'utf8');
          for (const match of content.matchAll(/^\s*(?:GOOSE_MODEL|model)\s*:\s*["']?([a-zA-Z0-9_.:/-]+)["']?/gm)) {
            addModel(match[1]);
          }
        }
      }
    } else if (peer === 'hermes') {
      if (home) {
        const yamlFile = path.join(home, '.hermes', 'config.yaml');
        if (fs.existsSync(yamlFile)) {
          const content = fs.readFileSync(yamlFile, 'utf8');
          for (const match of content.matchAll(/^\s*(?:default_)?model\s*:\s*["']?([a-zA-Z0-9_.:/-]+)["']?/gm)) {
            addModel(match[1]);
          }
        }
      }
    } else if (peer === 'pi') {
      if (home) {
        const settingsFile = path.join(home, '.pi', 'agent', 'settings.json');
        if (fs.existsSync(settingsFile)) {
          const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, unknown>;
          const defaultProvider = typeof parsed?.defaultProvider === 'string' ? parsed.defaultProvider.trim() : '';
          const defaultModel = typeof parsed?.defaultModel === 'string' ? parsed.defaultModel.trim() : '';
          if (defaultProvider && defaultModel) {
            addModel(`${defaultProvider}/${defaultModel}`);
          } else {
            addModel(defaultModel || parsed?.model);
          }
        }
        const modelsFile = path.join(home, '.pi', 'agent', 'models.json');
        if (fs.existsSync(modelsFile)) {
          const parsed = JSON.parse(fs.readFileSync(modelsFile, 'utf8')) as Record<string, unknown>;
          if (parsed?.providers && typeof parsed.providers === 'object') {
            for (const [provId, provData] of Object.entries(parsed.providers as Record<string, unknown>)) {
              if (provData && typeof provData === 'object' && Array.isArray((provData as Record<string, unknown>).models)) {
                for (const m of (provData as { models: Array<{ id?: string } | string> }).models) {
                  if (typeof m === 'string') addModel(`${provId}/${m}`);
                  else if (m && typeof m.id === 'string') addModel(`${provId}/${m.id}`);
                }
              }
            }
          }
        }
      }
    }
  } catch {
    // Ignore malformed user config files
  }

  return models;
}

function detectClaudeModels(): string[] {
  const models = detectPeerConfigModels('claude');
  const curated = PEER_MODEL_CATALOGUE['claude'] ?? ['sonnet', 'opus', 'haiku'];
  for (const m of curated) {
    if (!models.includes(m)) models.push(m);
  }
  return [...new Set(models)];
}

/**
 * Probe an ACP peer via zero-token `initialize` + `session/new` handshake to
 * discover the exact live models advertised for the user's current account/tier.
 */
export async function discoverPeerModelsViaAcp(
  peerId: string,
  timeoutMs = ACP_DISCOVERY_TIMEOUT_MS
): Promise<string[]> {
  const peer = (peerId || '').toLowerCase().trim();
  const profile = getPeerProfile(peer);
  const preset = BUILTIN_PEER_PRESETS[peer];
  if (!profile && !preset) return [];

  if (preset) {
    const hasDirectBinary = isBinaryOnPath(preset.binaryName);
    if (!hasDirectBinary) return [];
    const auth = await probePresetAuth(preset);
    if (!auth.authenticated) return [];
  }

  const command = profile?.command || preset?.command || peer;
  const args = profile?.args || preset?.args || ['acp'];
  if (!isBinaryOnPath(command)) return [];

  try {
    const handshake = await testPeerHandshake({
      command,
      args,
      cwd: process.cwd(),
      timeoutMs
    });
    if (handshake.ready && Array.isArray(handshake.availableModels) && handshake.availableModels.length > 0) {
      return [...new Set(handshake.availableModels)];
    }
  } catch {
    // Silent fallback if ACP handshake fails or times out
  }
  return [];
}

/** Discover live models from Pi CLI (`pi --list-models` + local config). */
export async function discoverPiModels(): Promise<string[]> {
  const configModels = detectPeerConfigModels('pi');
  if (isBinaryOnPath('pi')) {
    try {
      const { stdout } = await execFileAsync('pi', ['--list-models'], {
        timeout: MODEL_LIST_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, CI: '1', BROWSER: 'false', NO_BROWSER: '1' }
      });
      const parsed = parsePiModelsOutput(stdout);
      if (parsed.length > 0) {
        return [...new Set([...parsed, ...configModels])];
      }
    } catch {
      // Fall back to config or default
    }
  }
  return configModels.length > 0 ? configModels : ['default'];
}

/**
 * Ask a peer CLI which models its account can reach. Zero tokens: this runs the
 * peer's own listing command or zero-token ACP session handshake, never a prompt.
 */
export async function discoverPeerModels(
  peerId: string,
  options: { allowAcpHandshake?: boolean } = {}
): Promise<string[]> {
  const peer = (peerId || '').toLowerCase().trim();
  if (!peer) return [];
  if (peer === 'pi') {
    return discoverPiModels();
  }

  const configModels = detectPeerConfigModels(peer);

  // 1. Fast CLI `models` subcommand (e.g. `opencode models`, `cursor-agent models`)
  const listing = PEER_MODEL_COMMANDS[peer];
  if (listing && isBinaryOnPath(listing.command)) {
    const discovered = parseModelIds(await runModelList(listing.command, listing.args));
    if (discovered.length > 0) {
      return [...new Set([...discovered, ...configModels])];
    }
  }

  // 2. Zero-token ACP session/new discovery (`configOptions` / `models`)
  const allowHandshake = options.allowAcpHandshake ?? !process.env.NODE_TEST_CONTEXT;
  if (allowHandshake) {
    const acpModels = await discoverPeerModelsViaAcp(peer);
    if (acpModels.length > 0) {
      return [...new Set([...acpModels, ...configModels])];
    }
  }

  // 3. Local config + curated fallback
  if (peer === 'claude') {
    return detectClaudeModels();
  }
  if (configModels.length > 0) {
    return [...new Set([...configModels, ...(PEER_MODEL_CATALOGUE[peer] || [])])];
  }
  return PEER_MODEL_CATALOGUE[peer] ? [...PEER_MODEL_CATALOGUE[peer]] : [];
}

/** Ask Antigravity for its live model list and return the readable labels. */
export async function discoverAntigravityModels(
  options: { command?: string; forceSpawn?: boolean } = {}
): Promise<string[]> {
  const customCommand = options.command;
  const shouldSpawn = Boolean(customCommand)
    || Boolean(options.forceSpawn)
    || (!process.env.NODE_TEST_CONTEXT && isAntigravityOnboarded());

  if (shouldSpawn) {
    try {
      const bin = customCommand || resolveAgyBinary();
      const { stdout } = await execFileAsync(bin, ['models'], {
        timeout: MODEL_LIST_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, CI: '1', BROWSER: 'false', NO_BROWSER: '1' }
      });
      const parsed = parseAgyModelsOutput(stdout, { replaceActiveList: true });
      if (parsed.length > 0) {
        const modelIdMap: Record<string, string> = {};
        const labels: string[] = [];
        for (const item of parsed) {
          const label = item.label || item.id;
          modelIdMap[label] = item.id;
          if (!labels.includes(label)) labels.push(label);
        }
        saveCachedModels('antigravity', labels, { modelIdMap });
        return labels;
      }
    } catch {
      // Fall back to current registered or baseline models
    }
  }
  return [...ANTIGRAVITY_MODELS];
}

/** Read cache safely from ~/.causyne/models_cache.json */
export function readModelCache(): DynamicCatalogueCache | null {
  try {
    const file = cacheFilePath();
    if (!fs.existsSync(file)) return null;
    const content = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(content) as DynamicCatalogueCache;
    if (parsed && parsed.version === 1 && typeof parsed.providers === 'object') {
      return parsed;
    }
  } catch {
    // Graceful fallback on corrupt or inaccessible cache
  }
  return null;
}

/** Save cache safely to ~/.causyne/models_cache.json */
export function writeModelCache(cache: DynamicCatalogueCache): void {
  try {
    const dir = causyneHome();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const file = cacheFilePath();
    fs.writeFileSync(file, JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch {
    // Cache failures must never crash the CLI
  }
}

/** Get cached models for a provider if not expired and account fingerprint still matches */
export function getCachedModels(
  provider: string,
  config: { apiKey?: string; baseUrl?: string; providerKeys?: Record<string, string> } = {}
): string[] | null {
  const cache = readModelCache();
  if (!cache) return null;
  const norm = normalizeProviderKey(provider);
  const entry = cache.providers[norm];
  if (!entry || !Array.isArray(entry.models) || entry.models.length === 0) return null;

  const ttl = isLocalOrAcpProvider(norm) ? PEER_CACHE_TTL_MS : BYOK_CACHE_TTL_MS;
  if (Date.now() - entry.timestamp > ttl) return null;

  if (entry.fingerprint) {
    const currentFingerprint = computeProviderAuthFingerprint(norm, config);
    if (entry.fingerprint !== currentFingerprint) {
      return null;
    }
  }

  if (norm === 'antigravity' && entry.modelIdMap && typeof entry.modelIdMap === 'object') {
    for (const [label, slug] of Object.entries(entry.modelIdMap)) {
      if (typeof slug === 'string' && slug.trim()) {
        registerAntigravityModel(slug.trim(), label);
      }
    }
  }

  return entry.models;
}

/** Save models for a provider into the local cache along with its current account fingerprint */
export function saveCachedModels(
  provider: string,
  models: string[],
  options: {
    config?: { apiKey?: string; baseUrl?: string; providerKeys?: Record<string, string> };
    modelIdMap?: Record<string, string>;
    currentModel?: string;
  } = {}
): void {
  const norm = normalizeProviderKey(provider);
  const cache: DynamicCatalogueCache = readModelCache() || {
    version: 1,
    updatedAt: new Date().toISOString(),
    providers: {}
  };
  const entry: DynamicCatalogueCacheEntry = {
    timestamp: Date.now(),
    models: [...new Set(models)],
    fingerprint: computeProviderAuthFingerprint(norm, options.config)
  };
  if (options.modelIdMap && Object.keys(options.modelIdMap).length > 0) {
    entry.modelIdMap = { ...options.modelIdMap };
  } else if (norm === 'antigravity') {
    const map: Record<string, string> = {};
    for (const label of entry.models) {
      if (ANTIGRAVITY_MODEL_IDS[label]) {
        map[label] = ANTIGRAVITY_MODEL_IDS[label]!;
      }
    }
    if (Object.keys(map).length > 0) entry.modelIdMap = map;
  }
  if (options.currentModel) {
    entry.currentModel = options.currentModel;
  }
  cache.providers[norm] = entry;
  cache.updatedAt = new Date().toISOString();
  writeModelCache(cache);
}

/** Live query provider API or CLI/ACP peer to discover available models */
export async function fetchLiveModels(
  provider: string,
  config: { apiKey?: string; baseUrl?: string } = {}
): Promise<string[]> {
  const norm = normalizeProviderKey(provider);
  const { apiKey, baseUrl } = config;

  if (norm === 'antigravity') return discoverAntigravityModels();
  if (norm === 'pi') return discoverPiModels();
  const peer = peerIdFromProviderKey(norm);
  if (peer) return discoverPeerModels(peer);

  try {
    if (norm === 'ollama') {
      const host = (baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
      const res = await fetch(`${host}/api/tags`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (!res.ok) return [];
      const data = await res.json() as { models?: Array<{ name?: string }> };
      if (Array.isArray(data.models)) {
        return data.models
          .map((m) => (m.name || '').replace(/:latest$/, ''))
          .filter(Boolean);
      }
    }

    if (norm === 'openai') {
      if (!apiKey) return [];
      const host = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
      const res = await fetch(`${host}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (!res.ok) return [];
      const data = await res.json() as { data?: Array<{ id?: string }> };
      if (Array.isArray(data.data)) {
        return data.data
          .map((m) => m.id || '')
          .filter((id) => /^(gpt|o1|o3|chatgpt)/i.test(id))
          .sort();
      }
    }

    if (norm === 'gemini') {
      if (!apiKey) return [];
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (!res.ok) return [];
      const data = await res.json() as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
      if (Array.isArray(data.models)) {
        return data.models
          .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
          .map((m) => (m.name || '').replace(/^models\//, ''))
          .filter(Boolean)
          .sort();
      }
    }

    if (norm === 'anthropic') {
      if (!apiKey) return [];
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (!res.ok) return [];
      const data = await res.json() as { data?: Array<{ id?: string }> };
      if (Array.isArray(data.data)) {
        return data.data
          .map((m) => m.id || '')
          .filter(Boolean)
          .sort();
      }
    }

    if (norm === 'deepseek') {
      if (!apiKey) return [];
      const res = await fetch('https://api.deepseek.com/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (!res.ok) return [];
      const data = await res.json() as { data?: Array<{ id?: string }> };
      if (Array.isArray(data.data)) {
        return data.data.map((m) => m.id || '').filter(Boolean).sort();
      }
    }

    if (norm === 'openai-compatible') {
      if (!baseUrl) return [];
      const host = baseUrl.replace(/\/+$/, '');
      const headers: Record<string, string> = {};
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const res = await fetch(`${host}/models`, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (!res.ok) return [];
      const data = await res.json() as { data?: Array<{ id?: string }> };
      if (Array.isArray(data.data)) {
        return data.data.map((m) => m.id || '').filter(Boolean).sort();
      }
    }
  } catch {
    // Network errors or timeouts silently fall back
  }
  return [];
}

export interface ModelResolutionResult {
  models: string[];
  source: 'live' | 'cache' | 'catalogue';
}

/**
 * Resolve available models using dual-layer architecture:
 * 1. Checks live query if forceRefresh is true.
 * 2. Checks local cache if available and fresh.
 * 3. Falls back to static curated catalogue merged with any cached items.
 */
export async function resolveAvailableModels(
  provider: string,
  config: { apiKey?: string; baseUrl?: string; providerKeys?: Record<string, string> } = {},
  forceRefresh = false
): Promise<ModelResolutionResult> {
  const norm = normalizeProviderKey(provider);
  const curated = getCuratedModels(norm);
  const localAgent = isLocalOrAcpProvider(norm);

  if (forceRefresh) {
    const live = await fetchLiveModels(norm, config);
    if (live.length > 0) {
      const models = localAgent ? [...new Set(live)] : [...new Set([...live, ...curated])];
      saveCachedModels(norm, models, { config });
      return { models, source: 'live' };
    }
  }

  const cached = getCachedModels(norm, config);
  if (cached && cached.length > 0) {
    const models = localAgent ? [...new Set(cached)] : [...new Set([...cached, ...curated])];
    return { models, source: 'cache' };
  }

  // Attempt lazy background discovery if credentials exist. Peer agents and
  // Antigravity are credentialed by their own CLI login, so they qualify even
  // with no apiKey in Causyne's vault.
  if (config.apiKey || norm === 'ollama' || localAgent) {
    const live = await fetchLiveModels(norm, config);
    if (live.length > 0) {
      const models = localAgent ? [...new Set(live)] : [...new Set([...live, ...curated])];
      saveCachedModels(norm, models, { config });
      return { models, source: 'live' };
    }
  }

  return { models: curated, source: 'catalogue' };
}

/**
 * Asynchronously refresh installed ACP/local peers and configured BYOK providers
 * whose cache is missing, expired, or invalidated by an account/tier change,
 * then return the updated ProviderOverview.
 */
export async function resolveAvailableProvidersOverview(
  config: { provider?: string; apiKey?: string; model?: string; baseUrl?: string; providerKeys?: Record<string, string> } = {},
  options: { forceRefresh?: boolean } = {}
): Promise<ProviderOverview> {
  const initial = getAvailableProvidersOverview(config);
  const forceRefresh = Boolean(options.forceRefresh);
  const tasks: Array<Promise<unknown>> = [];

  for (const peer of initial.acp) {
    if (!peer.installed) continue;
    const cached = getCachedModels(peer.providerKey, config);
    if (forceRefresh || !cached || cached.length === 0) {
      tasks.push(
        resolveAvailableModels(peer.providerKey, config, forceRefresh).catch(() => null)
      );
    }
  }

  for (const byok of initial.byok) {
    if (!byok.isConfigured) continue;
    const cached = getCachedModels(byok.id, config);
    if (forceRefresh || (!cached && byok.id === String(config.provider || '').toLowerCase())) {
      const apiKey = (config.provider === byok.id && config.apiKey)
        || (config.providerKeys && config.providerKeys[byok.id])
        || (byok.envVar && process.env[byok.envVar])
        || '';
      if (apiKey || byok.id === 'ollama') {
        tasks.push(
          resolveAvailableModels(byok.id, { ...config, apiKey }, forceRefresh).catch(() => null)
        );
      }
    }
  }

  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }

  return getAvailableProvidersOverview(config);
}

/**
 * Select the most appropriate default model for a peer/provider given its live
 * or cached advertised model list. Prefers the canonical default if still present
 * on the user's account, otherwise falls back to the first live advertised model.
 */
export function pickDefaultPeerModel(providerKey: string, advertisedModels: string[] = []): string {
  const norm = normalizeProviderKey(providerKey);
  const staticDefault = (DEFAULT_MODEL_BY_PROVIDER as Record<string, string>)[norm];
  if (Array.isArray(advertisedModels) && advertisedModels.length > 0) {
    if (staticDefault && advertisedModels.includes(staticDefault)) {
      return staticDefault;
    }
    return advertisedModels[0]!;
  }
  const peer = peerIdFromProviderKey(norm);
  return staticDefault || peer || norm;
}
