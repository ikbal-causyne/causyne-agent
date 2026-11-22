/**
 * Causyne Agent — ACP Agent Catalog & Zero-Token Discovery
 *
 * Provides built-in profiles, auth probing, and zero-token discovery for
 * common external coding agents that support the Agent Client Protocol (ACP),
 * such as Claude Code, Codex, OpenCode, Gemini CLI, Hermes, Cursor CLI,
 * Qwen, Copilot, Kimi, and Goose.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AcpClient } from './client.js';
import { redactProviderSecrets } from '../providers/byokHttp.js';
import type { PeerProfile } from './peerProfiles.js';

const execFileAsync = promisify(execFile);

export interface BuiltinPeerPreset {
  id: string;
  label: string;
  description: string;
  command: string;
  args: string[];
  binaryName: string;
  fallbackCommand?: string;
  fallbackArgs?: string[];
  authType: 'subscription' | 'oauth' | 'api_key' | 'none';
  authProbe?: {
    type: 'json' | 'output_match' | 'file_exists';
    command?: string;
    args?: string[];
    filePath?: string;
    positiveMatch?: string;
    negativeMatch?: string;
    jsonField?: string;
  };
  setupInstruction?: string;
  timeoutSeconds?: number;
}

export interface PeerDetectionResult {
  id: string;
  label: string;
  status: 'ready' | 'needs_auth' | 'not_installed' | 'error';
  command: string;
  args: string[];
  details?: string;
  agentInfo?: { name: string; version: string };
  authMethods?: string[];
  availableModels?: string[];
  currentModelId?: string;
  setupInstruction?: string;
}

export const BUILTIN_PEER_PRESETS: Record<string, BuiltinPeerPreset> = {
  antigravity: {
    id: 'antigravity',
    label: 'Google Antigravity (AGY)',
    description: 'Google Antigravity agent CLI with Gemini and Claude frontier models',
    command: 'agy',
    args: ['--output-format', 'json'],
    binaryName: 'agy',
    authType: 'none',
    setupInstruction: 'Install Antigravity IDE or CLI to enable Google AGY models',
    timeoutSeconds: 180
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    description: 'OpenCode AI coding agent with support for free and local models',
    command: 'opencode',
    args: ['acp'],
    binaryName: 'opencode',
    fallbackCommand: 'npx',
    fallbackArgs: ['-y', 'opencode-ai', 'acp'],
    authType: 'none',
    setupInstruction: 'Run "opencode auth login" or configure a model in ~/.config/opencode',
    timeoutSeconds: 180
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    description: 'Anthropic Claude Code CLI via official ACP bridge adapter',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp@0.70.0'],
    binaryName: 'claude',
    authType: 'subscription',
    authProbe: {
      type: 'json',
      command: 'claude',
      args: ['auth', 'status', '--json'],
      jsonField: 'loggedIn'
    },
    setupInstruction: 'Run "claude login" to authenticate with your Anthropic subscription or set ANTHROPIC_API_KEY',
    timeoutSeconds: 300
  },
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    description: 'OpenAI Codex CLI coding agent via ACP adapter',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/codex-acp@1.6.0'],
    binaryName: 'codex',
    authType: 'subscription',
    authProbe: {
      type: 'output_match',
      command: 'codex',
      args: ['login', 'status'],
      positiveMatch: 'logged in',
      negativeMatch: 'not logged in'
    },
    setupInstruction: 'Run "codex login" or set OPENAI_API_KEY in your environment',
    timeoutSeconds: 300
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    description: 'Google Gemini CLI agent with free tier model support',
    command: 'gemini',
    args: ['--acp'],
    binaryName: 'gemini',
    fallbackCommand: 'npx',
    fallbackArgs: ['-y', '@google/gemini-cli', '--acp'],
    authType: 'oauth',
    authProbe: {
      type: 'file_exists',
      filePath: os.homedir() ? path.join(os.homedir(), '.gemini', 'oauth_creds.json') : ''
    },
    setupInstruction: 'Run "gemini auth" or set GEMINI_API_KEY in your environment',
    timeoutSeconds: 240
  },
  hermes: {
    id: 'hermes',
    label: 'Hermes Agent',
    description: 'Nous Research Hermes autonomous AI agent',
    command: 'hermes',
    args: ['acp'],
    binaryName: 'hermes',
    authType: 'api_key',
    setupInstruction: 'Run "hermes acp --setup" to configure provider credentials',
    timeoutSeconds: 240
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor CLI',
    description: 'Cursor CLI coding agent over ACP',
    command: 'cursor-agent',
    args: ['acp'],
    binaryName: 'cursor-agent',
    authType: 'subscription',
    setupInstruction: 'Run "cursor-agent login" to sign in to your Cursor account',
    timeoutSeconds: 180
  },
  qwen: {
    id: 'qwen',
    label: 'Qwen Code',
    description: 'Alibaba Qwen Code AI assistant over ACP',
    command: 'qwen',
    args: ['--acp'],
    binaryName: 'qwen',
    authType: 'api_key',
    setupInstruction: 'Set DASHSCOPE_API_KEY or run "qwen login"',
    timeoutSeconds: 180
  },
  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    description: 'GitHub Copilot CLI agent over ACP',
    command: 'copilot',
    args: ['--acp', '--stdio'],
    binaryName: 'copilot',
    authType: 'subscription',
    setupInstruction: 'Run "copilot auth" to link your GitHub Copilot subscription',
    timeoutSeconds: 180
  },
  kimi: {
    id: 'kimi',
    label: 'Kimi CLI',
    description: 'Moonshot AI Kimi coding assistant via ACP',
    command: 'kimi',
    args: ['acp'],
    binaryName: 'kimi',
    authType: 'api_key',
    setupInstruction: 'Set MOONSHOT_API_KEY in your environment',
    timeoutSeconds: 180
  },
  goose: {
    id: 'goose',
    label: 'Goose CLI',
    description: 'Block Goose extensible AI coding agent',
    command: 'goose',
    args: ['acp'],
    binaryName: 'goose',
    authType: 'api_key',
    setupInstruction: 'Run "goose configure" to set up providers',
    timeoutSeconds: 180
  }
};

/**
 * Check if a command or binary exists in PATH.
 */
export function isBinaryOnPath(binaryName: string): boolean {
  if (typeof binaryName !== 'string' || !binaryName.trim() || /[\r\n\0]/.test(binaryName)) {
    return false;
  }
  const trimmed = binaryName.trim();
  if (path.isAbsolute(trimmed)) {
    try {
      const stat = fs.statSync(trimmed);
      if (!stat.isFile()) return false;
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
        // Skip inaccessible or non-executable path segments
      }
    }
  }
  return false;
}

/**
 * Probe authorization state without spending model tokens.
 */
export async function probePresetAuth(preset: BuiltinPeerPreset): Promise<{ authenticated: boolean; reason?: string }> {
  if (!preset.authProbe) {
    return { authenticated: true };
  }

  const probe = preset.authProbe;

  if (probe.type === 'file_exists') {
    if (!probe.filePath || !path.isAbsolute(probe.filePath)) {
      return { authenticated: false, reason: 'Credentials file path unavailable' };
    }
    let exists = false;
    try {
      const stat = fs.lstatSync(probe.filePath);
      exists = !stat.isSymbolicLink() && stat.isFile();
    } catch {
      exists = false;
    }
    return {
      authenticated: exists,
      reason: exists ? 'OAuth credentials file detected' : `Credentials file not found at ${probe.filePath}`
    };
  }

  if (probe.type === 'json' && probe.command) {
    if (!isBinaryOnPath(probe.command)) {
      return { authenticated: false, reason: `${probe.command} CLI not found on PATH` };
    }
    try {
      const { stdout } = await execFileAsync(probe.command, probe.args || [], { timeout: 8000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
      const parsed = JSON.parse(stdout.trim());
      if (probe.jsonField && typeof parsed === 'object' && parsed !== null) {
        const val = (parsed as Record<string, unknown>)[probe.jsonField];
        const isAuth = Boolean(val);
        return {
          authenticated: isAuth,
          reason: isAuth ? 'Valid CLI login session active' : 'CLI reports not logged in'
        };
      }
      return { authenticated: true, reason: 'CLI auth responded' };
    } catch {
      return { authenticated: false, reason: `Failed to probe ${probe.command} auth status` };
    }
  }

  if (probe.type === 'output_match' && probe.command) {
    if (!isBinaryOnPath(probe.command)) {
      return { authenticated: false, reason: `${probe.command} CLI not found on PATH` };
    }
    try {
      const result = await execFileAsync(probe.command, probe.args || [], { timeout: 8000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }).catch((e) => e);
      const combined = `${result?.stdout || ''}\n${result?.stderr || ''}`.toLowerCase();
      if (probe.negativeMatch && combined.includes(probe.negativeMatch.toLowerCase())) {
        return { authenticated: false, reason: 'CLI reported not logged in' };
      }
      if (probe.positiveMatch && combined.includes(probe.positiveMatch.toLowerCase())) {
        return { authenticated: true, reason: 'CLI login detected' };
      }
      return { authenticated: false, reason: 'No active login detected' };
    } catch {
      return { authenticated: false, reason: `Failed to probe ${probe.command} auth` };
    }
  }

  return { authenticated: true };
}

/**
 * Execute a zero-token ACP handshake (initialize + session/new) with strict timeout.
 * Never sends session/prompt, ensuring $0 token consumption.
 */
export async function testPeerHandshake(
  options: {
    command: string;
    args?: string[];
    cwd?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
  }
): Promise<{
  ready: boolean;
  agentInfo?: { name: string; version: string };
  authMethods?: string[];
  availableModels?: string[];
  currentModelId?: string;
  error?: string;
}> {
  const cwd = options.cwd || process.cwd();
  const rawTimeout = options.timeoutMs;
  const timeoutMs = typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
    ? Math.max(1_000, Math.min(120_000, Math.round(rawTimeout)))
    : 12_000;
  const handshakeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(options.env && typeof options.env === 'object' ? options.env : {}),
    CI: '1',
    BROWSER: 'false',
    NO_BROWSER: '1'
  };
  delete handshakeEnv.CAUSYNE_VAULT_KEY;
  delete handshakeEnv.CAUSYNE_DEV_SECRET;
  delete handshakeEnv.CAUSYNE_DEV_TOKEN;
  const clientOptions: {
    command: string;
    args?: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    promptTimeoutMs: number;
  } = {
    command: options.command,
    cwd,
    env: handshakeEnv,
    promptTimeoutMs: timeoutMs
  };
  if (options.args) {
    clientOptions.args = options.args;
  }
  const client = new AcpClient(clientOptions);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`ACP handshake timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();
  try {
    const init = await client.start(controller.signal);

    const agentInfo = init.agentInfo ? { name: init.agentInfo.name, version: init.agentInfo.version } : undefined;
    const authMethods = Array.isArray(init.authMethods)
      ? init.authMethods.map((m) => (typeof m === 'object' && m !== null && 'id' in m ? String((m as { id: unknown }).id) : String(m)))
      : [];

    // Attempt session/new under the same bounded deadline to ensure full readiness and extract live models
    try {
      const sessionId = await client.newSession(cwd, [], controller.signal);
      const sessionModels = client.getSessionModels(sessionId);
      return {
        ready: true,
        ...(agentInfo ? { agentInfo } : {}),
        authMethods,
        ...(sessionModels.availableModels.length > 0 ? { availableModels: sessionModels.availableModels } : {}),
        ...(sessionModels.currentModelId ? { currentModelId: sessionModels.currentModelId } : {})
      };
    } catch (sessionErr: unknown) {
      const rawMsg = timedOut
        ? `ACP session/new timed out after ${timeoutMs}ms`
        : (sessionErr instanceof Error ? sessionErr.message : String(sessionErr));
      const msg = redactProviderSecrets(rawMsg);
      return {
        ready: false,
        ...(agentInfo ? { agentInfo } : {}),
        authMethods,
        error: `Session creation failed: ${msg}`
      };
    }
  } catch (initErr: unknown) {
    const rawMsg = timedOut
      ? `ACP initialization timed out after ${timeoutMs}ms`
      : (initErr instanceof Error ? initErr.message : String(initErr));
    const msg = redactProviderSecrets(rawMsg);
    return { ready: false, error: msg };
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}

export function isAuthRequiredHandshakeFailure(handshake: {
  ready: boolean;
  authMethods?: string[];
  error?: string;
}): boolean {
  if (handshake.ready) return false;
  const err = String(handshake.error || '');
  if (/(?:auth|unauthorized|unauthenticated|api[_ ]?key|credential|login|unknown provider|not configured|token.*(?:missing|invalid|expired))/i.test(err)) {
    return true;
  }
  return Array.isArray(handshake.authMethods) && handshake.authMethods.length > 0;
}

/**
 * Detect all built-in ACP presets available on this machine and report their readiness.
 */
export async function detectAllPeers(cwd: string = process.cwd()): Promise<PeerDetectionResult[]> {
  const presets = Object.values(BUILTIN_PEER_PRESETS);

  const probeOne = async (preset: BuiltinPeerPreset): Promise<PeerDetectionResult> => {
    const hasDirectBinary = preset.id === 'cursor'
      ? (isBinaryOnPath('cursor-agent') || isBinaryOnPath('cursor'))
      : isBinaryOnPath(preset.binaryName);
    const hasRunner = preset.command !== 'npx' && isBinaryOnPath(preset.command);

    if (!hasDirectBinary && !hasRunner) {
      return {
        id: preset.id,
        label: preset.label,
        status: 'not_installed',
        command: preset.command,
        args: preset.args,
        details: `Binary "${preset.binaryName}" not found on PATH.`,
        ...(preset.setupInstruction ? { setupInstruction: preset.setupInstruction } : {})
      };
    }

    // Determine actual command to execute
    let activeCommand = preset.command;
    let activeArgs = preset.args;

    if (!hasDirectBinary && preset.fallbackCommand && isBinaryOnPath(preset.fallbackCommand)) {
      activeCommand = preset.fallbackCommand;
      activeArgs = preset.fallbackArgs || [];
    }

    // Run auth probe
    const auth = await probePresetAuth(preset);
    if (!auth.authenticated) {
      return {
        id: preset.id,
        label: preset.label,
        status: 'needs_auth',
        command: activeCommand,
        args: activeArgs,
        details: auth.reason || 'Authentication required.',
        ...(preset.setupInstruction ? { setupInstruction: preset.setupInstruction } : {})
      };
    }

    // Antigravity communicates natively via CLI JSON mode
    if (preset.id === 'antigravity') {
      return {
        id: preset.id,
        label: preset.label,
        status: 'ready',
        command: activeCommand,
        args: activeArgs,
        agentInfo: { name: 'Google Antigravity', version: '2.0' },
        details: 'Operational via local AGY CLI with Gemini & Claude frontier models.'
      };
    }

    // Run zero-token handshake
    const handshake = await testPeerHandshake({
      command: activeCommand,
      args: activeArgs,
      cwd,
      timeoutMs: 8000
    });

    if (handshake.ready) {
      return {
        id: preset.id,
        label: preset.label,
        status: 'ready',
        command: activeCommand,
        args: activeArgs,
        ...(handshake.agentInfo ? { agentInfo: handshake.agentInfo } : {}),
        ...(handshake.authMethods ? { authMethods: handshake.authMethods } : {}),
        ...(handshake.availableModels ? { availableModels: handshake.availableModels } : {}),
        ...(handshake.currentModelId ? { currentModelId: handshake.currentModelId } : {}),
        details: 'Operational and ready for delegation.'
      };
    }
    if (isAuthRequiredHandshakeFailure(handshake)) {
      return {
        id: preset.id,
        label: preset.label,
        status: 'needs_auth',
        command: activeCommand,
        args: activeArgs,
        ...(handshake.agentInfo ? { agentInfo: handshake.agentInfo } : {}),
        ...(handshake.authMethods ? { authMethods: handshake.authMethods } : {}),
        details: handshake.error || 'Authentication required.',
        ...(preset.setupInstruction ? { setupInstruction: preset.setupInstruction } : {})
      };
    }
    return {
      id: preset.id,
      label: preset.label,
      status: hasDirectBinary ? 'error' : 'not_installed',
      command: activeCommand,
      args: activeArgs,
      details: handshake.error || 'ACP handshake did not complete.',
      ...(preset.setupInstruction ? { setupInstruction: preset.setupInstruction } : {})
    };
  };

  // Run peer detections concurrently with bounded parallelism (4 lanes) while preserving preset order
  const results: PeerDetectionResult[] = new Array(presets.length);
  let cursor = 0;
  const concurrency = Math.min(4, Math.max(1, presets.length));
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < presets.length) {
      const idx = cursor++;
      results[idx] = await probeOne(presets[idx]!);
    }
  }));

  return results;
}

/**
 * Convert a preset to a runnable PeerProfile.
 */
export function getPresetProfile(id: string): PeerProfile | null {
  if (typeof id !== 'string') return null;
  const key = id.trim().toLowerCase();
  if (!key || !Object.hasOwn(BUILTIN_PEER_PRESETS, key)) return null;
  const preset = BUILTIN_PEER_PRESETS[key];
  if (!preset) return null;

  return {
    id: preset.id,
    label: preset.label,
    command: preset.command,
    args: [...preset.args],
    cwd: null,
    policy: 'workspace',
    timeoutSeconds: preset.timeoutSeconds || 180,
    env: {}
  };
}
