/**
 * Causyne Agent — Unified Permission Presets (`read-only` | `workspace-write` | `danger-full-access`)
 *
 * Single source of truth governing Causyne's execution posture across:
 *   - Sandbox enforcement (`src/sandbox.ts`)
 *   - Tool approval policy (`src/approvalPolicy.ts` / `AgentLoop`)
 *   - Skybridge Web Studio composer pill, Settings default selector, and Risk Confirmation gate
 *   - CLI/TUI `/mode` and `/permissions` commands
 *
 * Preserves connected ACP peer capabilities per ACP capability policy (never strips peer tools).
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from './infra/atomicWriter.js';
import { loadConfig, saveConfig } from './config.js';
import { causyneHome } from './utils/paths.js';

export type PermissionPresetId = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface PermissionPresetDescriptor {
  readonly id: PermissionPresetId;
  readonly label: string;
  readonly shortLabel: string;
  readonly description: string;
  readonly autonomyMode: 'A' | 'B' | 'C';
  readonly readOnly: boolean;
  readonly requiresRiskConfirmation: boolean;
}

export const PERMISSION_PRESET_IDS: readonly PermissionPresetId[] = Object.freeze([
  'read-only',
  'workspace-write',
  'danger-full-access'
]);

export const PERMISSION_PRESET_CATALOG: readonly PermissionPresetDescriptor[] = Object.freeze([
  {
    id: 'read-only',
    label: 'Read Only',
    shortLabel: 'Read Only',
    description: 'Inspect files, search code, and read web pages without modifying workspace files or running mutating commands.',
    autonomyMode: 'A',
    readOnly: true,
    requiresRiskConfirmation: false
  },
  {
    id: 'workspace-write',
    label: 'Workspace Write',
    shortLabel: 'Workspace Write',
    description: 'Read and modify files strictly within the locked workspace while asking approval for dangerous or external actions.',
    autonomyMode: 'B',
    readOnly: false,
    requiresRiskConfirmation: false
  },
  {
    id: 'danger-full-access',
    label: 'Full access',
    shortLabel: 'Full access',
    description: 'Reduces confirmation steps and performs workspace actions and commands directly while keeping forbidden-command and credential safeguards active.',
    autonomyMode: 'C',
    readOnly: false,
    requiresRiskConfirmation: true
  }
]);

export function normalizePermissionPreset(raw: unknown): PermissionPresetId | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned) return null;
  if (
    cleaned === 'read-only'
    || cleaned === 'readonly'
    || cleaned === 'read_only'
    || cleaned === 'read only'
    || cleaned === 'a'
    || cleaned === 'ask'
    || cleaned === 'supervised'
    || cleaned === 'strict'
  ) {
    return 'read-only';
  }
  if (
    cleaned === 'workspace-write'
    || cleaned === 'workspace_write'
    || cleaned === 'workspace write'
    || cleaned === 'workspace'
    || cleaned === 'b'
    || cleaned === 'balanced'
    || cleaned === 'default'
  ) {
    return 'workspace-write';
  }
  if (
    cleaned === 'danger-full-access'
    || cleaned === 'full-access'
    || cleaned === 'full_access'
    || cleaned === 'full access'
    || cleaned === 'full'
    || cleaned === 'c'
    || cleaned === 'autonomous'
    || cleaned === 'auto'
  ) {
    return 'danger-full-access';
  }
  return null;
}

export function getPermissionPresetDescriptor(id: PermissionPresetId): PermissionPresetDescriptor {
  return PERMISSION_PRESET_CATALOG.find((p) => p.id === id) ?? PERMISSION_PRESET_CATALOG[1]!;
}

export function resolveConfigPermissionPreset(
  config: Record<string, unknown> | null | undefined,
  fallback: PermissionPresetId = 'workspace-write'
): PermissionPresetId {
  if (!config || typeof config !== 'object') return fallback;
  const explicit = normalizePermissionPreset(config.permissionPreset);
  const legacy = normalizePermissionPreset(config.autonomyMode);
  if (explicit && legacy && presetToAutonomyMode(explicit) !== presetToAutonomyMode(legacy)) {
    return legacy;
  }
  if (explicit) return explicit;
  if (legacy) return legacy;
  return fallback;
}

export function formatPermissionPresetLabel(raw: unknown, fallback: PermissionPresetId = 'workspace-write'): string {
  const preset = normalizePermissionPreset(raw) ?? fallback;
  return getPermissionPresetDescriptor(preset).label;
}

export function presetToAutonomyMode(preset: PermissionPresetId): 'A' | 'B' | 'C' {
  return getPermissionPresetDescriptor(preset).autonomyMode;
}

export function autonomyModeToPreset(mode: unknown): PermissionPresetId {
  const m = typeof mode === 'string' ? mode.trim().toUpperCase() : '';
  if (m === 'A') return 'read-only';
  if (m === 'C') return 'danger-full-access';
  return 'workspace-write';
}

export function renderPermissionPolicyContext(preset: PermissionPresetId, workspaceRoot: string): string {
  switch (preset) {
    case 'read-only':
      return `Current Causyne permission preset: Read Only. File modifications and mutating shell commands are blocked while Read Only is active (workspace: ${JSON.stringify(workspaceRoot)}).`;
    case 'workspace-write':
      return `Current Causyne permission preset: Workspace Write. File edits are scoped to the locked session workspace (${JSON.stringify(workspaceRoot)}) with approval required for dangerous operations.`;
    case 'danger-full-access':
      return `Current Causyne permission preset: Full access. Routine workspace edits and commands execute directly within policy; forbidden commands and credential safeguards remain enforced.`;
  }
}

const READ_ONLY_BLOCKED_TOOLS = new Set([
  'fs_write',
  'fs_edit',
  'MultiEdit',
  'apply_patch',
  'fs_move',
  'fs_delete',
  'skill_create',
  'tool_forge',
  'plugin_manager',
  'plugins_factory',
  'document_forge',
  'ui_forge',
  'desktop_act',
  'computer_use',
  'proc_term',
  'printer_print',
  'archive',
  'manage_local_dependencies',
  'open_source_tool_provisioner',
  'generate_media_via_api',
  'execute_procedural_media',
  'game_build_html5',
  'game_asset_fetch',
  'game_asset_harvest',
  'game_scene_build',
  'game_entity_spawner',
  'game_tilemap_gen',
  'game_ui_hud_builder',
  'game_audio_synth',
  'game_vfx_emitter_gen',
  'game_shader_forge',
  'game_data_forge',
  'blender_act',
  'godot_act',
  'resolve_act',
  'palmier_act',
  'native_engine'
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'branch', 'tag', 'rev-parse', 'ls-files', 'ls-tree',
  'blame', 'shortlog', 'describe', 'cat-file', 'merge-base', 'grep', 'config', 'remote'
]);

const READ_ONLY_SHELL_LEADING = new Set([
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'which', 'whereis',
  'echo', 'printf', 'env', 'printenv', 'uname', 'whoami', 'id', 'date', 'stat', 'file',
  'du', 'df', 'ps', 'lsof', 'tree', 'git', 'node', 'npm', 'tsc', 'python3', 'python'
]);

const SHELL_MUTATION_OPERATORS = /(?:^|[^0-9])>>?\s*\S|\b(?:rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|dd|tee|truncate|unlink|shred|sed\s+-i|perl\s+-i|npm\s+(?:i|install|uninstall|ci|publish|update)|git\s+(?:add|commit|push|pull|merge|rebase|checkout|switch|reset|clean|rm|mv|stash|cherry-pick|revert))\b/i;

function isReadOnlyShellCommand(rawCmd: string): boolean {
  const cmd = rawCmd.trim();
  if (!cmd) return false;
  if (SHELL_MUTATION_OPERATORS.test(cmd)) return false;
  const firstToken = cmd.split(/\s+/)[0]?.toLowerCase() ?? '';
  if (!READ_ONLY_SHELL_LEADING.has(firstToken)) return false;
  if (firstToken === 'find' && /\s-(?:delete|exec|execdir|ok|okdir)\b/i.test(cmd)) return false;
  if (firstToken === 'git') {
    const sub = cmd.split(/\s+/)[1]?.toLowerCase() ?? '';
    return READ_ONLY_GIT_SUBCOMMANDS.has(sub);
  }
  if (firstToken === 'node' || firstToken === 'python' || firstToken === 'python3') {
    return /^[\w.-]+\s+(?:--version|-v)\s*$/i.test(cmd);
  }
  if (firstToken === 'npm') {
    return /^npm\s+(?:--version|-v|ls|list|outdated|view|info|search)\b/i.test(cmd);
  }
  if (firstToken === 'tsc') {
    return /\s--noEmit\b/.test(cmd);
  }
  return true;
}

/**
 * Returns a human-readable denial reason when a tool invocation would mutate state
 * under the `read-only` permission preset, or `null` if permitted.
 */
export function readOnlyPresetViolation(toolName: string, args: Record<string, unknown>): string | null {
  const canonical = String(toolName || '').trim().replace(/\./g, '_');
  if (READ_ONLY_BLOCKED_TOOLS.has(canonical)) {
    return `Blocked by Read Only permission preset: "${toolName}" modifies workspace or host state. Switch to Workspace Write or Full access to proceed.`;
  }

  if (canonical === 'web_fetch' && typeof args.outputFile === 'string' && args.outputFile.trim()) {
    return 'Blocked by Read Only permission preset: downloading files to disk is disabled in Read Only mode.';
  }

  if (canonical === 'git_worktree') {
    const act = String(args.action ?? '').trim().toLowerCase();
    if (act !== 'list' && act !== 'diff') {
      return `Blocked by Read Only permission preset: git_worktree action "${act || 'mutate'}" modifies worktrees.`;
    }
    return null;
  }

  if (canonical === 'gitOp') {
    const raw = String(args.subcommand ?? args.command ?? args.action ?? args.op ?? '').trim();
    const withoutPrefix = raw.toLowerCase().startsWith('git ') ? raw.slice(4).trim() : raw;
    const sub = withoutPrefix.split(/\s+/)[0]?.toLowerCase() ?? '';
    if (!READ_ONLY_GIT_SUBCOMMANDS.has(sub)) {
      return `Blocked by Read Only permission preset: "git ${sub || raw}" can mutate repository state.`;
    }
    return null;
  }

  if (canonical === 'terminal_pty') {
    const act = String(args.action ?? '').trim().toLowerCase();
    if (act === 'list' || act === 'read' || act === 'resize') return null;
    if (act === 'send' && typeof args.input === 'string' && isReadOnlyShellCommand(args.input)) return null;
    return `Blocked by Read Only permission preset: interactive terminal action "${act || 'open'}" is restricted in Read Only mode.`;
  }

  if (canonical === 'sysRun' || canonical === 'sysRunBg' || canonical === 'terminal_persistent_shell' || canonical === 'task_bg') {
    if (canonical === 'task_bg') {
      const act = String(args.action ?? 'list').trim().toLowerCase();
      if (act === 'list' || act === 'status' || act === 'output' || act === 'wait') return null;
    }
    const command = String(args.command ?? args.input ?? args.cmd ?? '').trim();
    if (!isReadOnlyShellCommand(command)) {
      return 'Blocked by Read Only permission preset: only read-only inspection commands are allowed. Switch to Workspace Write or Full access to execute mutating commands.';
    }
    return null;
  }

  return null;
}

interface SessionPermissionStoreFile {
  version: 1;
  sessions: Record<string, { preset: PermissionPresetId; updatedAt: number }>;
}

const MAX_PERSISTED_SESSION_OVERRIDES = 250;

function sessionPermissionsPath(): string {
  return path.join(causyneHome(), 'session-permissions.json');
}

function readSessionPermissionStore(): SessionPermissionStoreFile {
  try {
    const fp = sessionPermissionsPath();
    if (!fs.existsSync(fp)) return { version: 1, sessions: {} };
    const stat = fs.lstatSync(fp);
    if (stat.isSymbolicLink() || !stat.isFile()) return { version: 1, sessions: {} };
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8')) as Partial<SessionPermissionStoreFile>;
    const sessions: Record<string, { preset: PermissionPresetId; updatedAt: number }> = {};
    if (raw && raw.sessions && typeof raw.sessions === 'object') {
      for (const [sid, entry] of Object.entries(raw.sessions)) {
        if (!sid || sid === '__proto__' || sid === 'constructor' || sid === 'prototype') continue;
        const norm = normalizePermissionPreset((entry as { preset?: unknown })?.preset);
        if (!norm) continue;
        const updatedAt = Number((entry as { updatedAt?: unknown })?.updatedAt) || Date.now();
        sessions[sid] = { preset: norm, updatedAt };
      }
    }
    return { version: 1, sessions };
  } catch {
    return { version: 1, sessions: {} };
  }
}

function writeSessionPermissionStore(store: SessionPermissionStoreFile): void {
  const entries = Object.entries(store.sessions)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, MAX_PERSISTED_SESSION_OVERRIDES);
  const pruned: SessionPermissionStoreFile = {
    version: 1,
    sessions: Object.fromEntries(entries)
  };
  atomicWriteFileSync(sessionPermissionsPath(), `${JSON.stringify(pruned, null, 2)}\n`);
}

export function getDefaultPermissionPreset(): PermissionPresetId {
  const config = loadConfig() as Record<string, unknown>;
  const explicit = normalizePermissionPreset(config.permissionPreset);
  if (explicit) return explicit;
  return autonomyModeToPreset(config.autonomyMode);
}

export function setDefaultPermissionPreset(preset: PermissionPresetId): PermissionPresetId {
  const config = loadConfig() as Record<string, unknown>;
  config.permissionPreset = preset;
  config.autonomyMode = presetToAutonomyMode(preset);
  saveConfig(config as any);
  return preset;
}

export function getSessionPermissionPreset(sessionId?: string | null): PermissionPresetId {
  if (typeof sessionId === 'string' && sessionId.trim()) {
    const store = readSessionPermissionStore();
    const rec = store.sessions[sessionId.trim()];
    if (rec) return rec.preset;
  }
  return getDefaultPermissionPreset();
}

export function setSessionPermissionPreset(sessionId: string, preset: PermissionPresetId): PermissionPresetId {
  const sid = sessionId.trim();
  if (!sid) return setDefaultPermissionPreset(preset);
  const store = readSessionPermissionStore();
  store.sessions[sid] = { preset, updatedAt: Date.now() };
  writeSessionPermissionStore(store);
  return preset;
}
