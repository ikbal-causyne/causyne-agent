import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from '../utils/paths.js';

export type PeerPolicy = 'read-only' | 'workspace';

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
    if (typeof item !== 'string') return null;
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
    if (typeof raw !== 'string') continue;
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
  if (!command || command.length > 500) return null;
  const args = asStringArray(record.args ?? [], MAX_ARGS, MAX_ARG_CHARS);
  if (args === null) return null;
  let cwd: string | null = null;
  if (typeof record.cwd === 'string' && record.cwd.trim()) {
    const resolved = path.resolve(record.cwd.trim());
    try {
      if (!fs.statSync(resolved).isDirectory()) return null;
      cwd = resolved;
    } catch {
      return null;
    }
  }
  const policy: PeerPolicy = record.policy === 'workspace' ? 'workspace' : 'read-only';
  const timeoutSeconds = typeof record.timeoutSeconds === 'number' && Number.isFinite(record.timeoutSeconds)
    ? Math.max(5, Math.min(1800, Math.round(record.timeoutSeconds)))
    : 120;
  const label = typeof record.label === 'string' && record.label.trim()
    ? record.label.trim().slice(0, 100)
    : id;
  return { id, label, command, args, cwd, policy, timeoutSeconds, env: asEnv(record.env) };
}

export function loadPeerProfiles(): PeerProfile[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(peerProfilesPath(), 'utf8'));
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

export function getPeerProfile(id: string): PeerProfile | null {
  return loadPeerProfiles().find((profile) => profile.id === id) ?? null;
}

export function peerEnvironment(profile: PeerProfile): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SYSTEMROOT']) {
    const value = process.env[name];
    if (typeof value === 'string') env[name] = value;
  }
  for (const [name, value] of Object.entries(profile.env)) env[name] = value;
  return env;
}
