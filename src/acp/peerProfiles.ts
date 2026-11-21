import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from '../utils/paths.js';
import { isBlockedWorkspaceRoot } from '../sandboxPolicy.js';
import { atomicWriteSecretFileSync } from '../configVault.js';
import { getPresetProfile, BUILTIN_PEER_PRESETS } from './agentCatalog.js';

export type PeerPolicy = 'read-only' | 'ask' | 'workspace';

export interface PeerProfile {
  id: string;
  label: string;
  command: string;
  args: string[];
  cwd: string | null;
  policy: PeerPolicy;
  timeoutSeconds: number;
  env: Record<string, string>;
}

export interface PeerProfilesFile {
  schemaVersion: number;
  peers: PeerProfile[];
}

const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_PEERS = 20;
const MAX_ARGS = 32;
const MAX_ARG_CHARS = 500;
const MAX_ENV_ENTRIES = 32;
const MAX_ENV_VALUE_CHARS = 2000;

export function peerProfilesPath(): string {
  return path.join(causyneHome(), 'peers.json');
}

function asStringArray(value: unknown, limit: number, maxChars: number): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > limit) return null;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || /[\r\n\0]/.test(item)) return null;
    result.push(item.slice(0, maxChars));
  }
  return result;
}

function asEnv(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  let count = 0;
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (count >= MAX_ENV_ENTRIES) break;
    if (!ENV_NAME.test(name)) continue;
    if (typeof raw !== 'string' || raw.includes('\0')) continue;
    result[name] = raw.slice(0, MAX_ENV_VALUE_CHARS);
    count += 1;
  }
  return result;
}

function parseProfile(raw: unknown): PeerProfile | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!PROFILE_ID.test(id)) return null;
  const command = typeof record.command === 'string' ? record.command.trim() : '';
  if (!command || command.length > 500 || /[\r\n\0]/.test(command)) return null;
  const args = asStringArray(record.args ?? [], MAX_ARGS, MAX_ARG_CHARS);
  if (args === null) return null;
  let cwd: string | null = null;
  if (typeof record.cwd === 'string' && record.cwd.trim()) {
    if (/[\r\n\0]/.test(record.cwd)) return null;
    const resolved = path.resolve(record.cwd.trim());
    if (isBlockedWorkspaceRoot(resolved)) return null;
    try {
      const real = fs.realpathSync(resolved);
      if (isBlockedWorkspaceRoot(real)) return null;
      if (!fs.statSync(real).isDirectory()) return null;
      cwd = real;
    } catch {
      return null;
    }
  }
  const policy: PeerPolicy = record.policy === 'read-only'
    ? 'read-only'
    : (record.policy === 'workspace' ? 'workspace' : 'ask');
  const timeoutSeconds = typeof record.timeoutSeconds === 'number' && Number.isFinite(record.timeoutSeconds)
    ? Math.max(5, Math.min(1800, Math.round(record.timeoutSeconds)))
    : 120;
  const rawLabel = typeof record.label === 'string' ? record.label.replace(/[\r\n\0]+/g, ' ').trim() : '';
  const label = rawLabel ? rawLabel.slice(0, 100) : id;
  return { id, label, command, args, cwd, policy, timeoutSeconds, env: asEnv(record.env) };
}

export function loadPeerProfiles(): PeerProfile[] {
  let raw: unknown;
  try {
    const file = peerProfilesPath();
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024) return [];
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  let entries: unknown;
  if (Array.isArray(raw)) {
    entries = raw;
  } else if (raw !== null && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).peers)) {
    entries = (raw as Record<string, unknown>).peers;
  } else {
    return [];
  }
  const profiles: PeerProfile[] = [];
  const seen = new Set<string>();
  for (const entry of entries as unknown[]) {
    if (profiles.length >= MAX_PEERS) break;
    const profile = parseProfile(entry);
    if (!profile || seen.has(profile.id)) continue;
    seen.add(profile.id);
    profiles.push(profile);
  }
  return profiles;
}

export function savePeerProfiles(profiles: PeerProfile[]): void {
  const file = peerProfilesPath();
  const content: PeerProfilesFile = {
    schemaVersion: 1,
    peers: profiles
  };
  atomicWriteSecretFileSync(file, JSON.stringify(content, null, 2));
}

export function addPeerProfile(profile: PeerProfile): { ok: boolean; error?: string } {
  const validated = parseProfile(profile);
  if (!validated) {
    return { ok: false, error: 'Invalid peer profile configuration.' };
  }
  const current = loadPeerProfiles();
  const idx = current.findIndex((p) => p.id === validated.id);
  if (idx >= 0) {
    current[idx] = validated;
  } else {
    if (current.length >= MAX_PEERS) {
      return { ok: false, error: `Maximum of ${MAX_PEERS} peer profiles exceeded.` };
    }
    current.push(validated);
  }
  try {
    savePeerProfiles(current);
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

export function removePeerProfile(id: string): { ok: boolean; error?: string } {
  const current = loadPeerProfiles();
  const filtered = current.filter((p) => p.id !== id);
  if (filtered.length === current.length) {
    return { ok: false, error: `Peer profile "${id}" is not configured.` };
  }
  try {
    savePeerProfiles(filtered);
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

/**
 * Resolves a peer profile by ID. Checks user configuration first;
 * if not found, falls back to built-in agent presets.
 */
export function getPeerProfile(id: string): PeerProfile | null {
  const normalizedId = String(id || '').trim().toLowerCase();
  const configured = loadPeerProfiles().find((profile) => profile.id.toLowerCase() === normalizedId);
  if (configured) return configured;

  // Fallback to built-in presets (e.g. opencode, claude, codex, hermes, cursor, gemini)
  return getPresetProfile(normalizedId);
}

/**
 * Returns all available peers: user configured peers plus all built-in presets
 * that are not already shadowed by a user profile.
 */
export function listAllPeers(): PeerProfile[] {
  const userPeers = loadPeerProfiles();
  const userIds = new Set(userPeers.map((p) => p.id.toLowerCase()));
  const all: PeerProfile[] = [...userPeers];

  for (const presetId of Object.keys(BUILTIN_PEER_PRESETS)) {
    if (!userIds.has(presetId)) {
      const presetProfile = getPresetProfile(presetId);
      if (presetProfile) {
        all.push(presetProfile);
      }
    }
  }

  return all;
}

const BLOCKED_PEER_ENV_KEYS = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'NODE_OPTIONS',
  'BASH_ENV',
  'ENV',
  'PYTHONSTARTUP'
]);

export function peerEnvironment(profile: PeerProfile): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const baseKeys = [
    'PATH', 'Path', 'PATHEXT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
    'SYSTEMROOT', 'SystemRoot', 'COMSPEC', 'ComSpec', 'ProgramData'
  ];
  for (const name of baseKeys) {
    const value = process.env[name];
    if (typeof value === 'string') env[name] = value;
  }
  for (const [name, value] of Object.entries(profile.env)) {
    if (BLOCKED_PEER_ENV_KEYS.has(name.toUpperCase())) continue;
    if (!ENV_NAME.test(name) || typeof value !== 'string' || value.includes('\0')) continue;
    env[name] = value;
  }
  return env;
}
