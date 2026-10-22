import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from '../utils/paths.js';
import { getPresetProfile, BUILTIN_PEER_PRESETS } from './agentCatalog.js';
const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_PEERS = 20;
const MAX_ARGS = 32;
const MAX_ARG_CHARS = 500;
const MAX_ENV_ENTRIES = 32;
const MAX_ENV_VALUE_CHARS = 2000;
export function peerProfilesPath() {
    return path.join(causyneHome(), 'peers.json');
}
function asStringArray(value, limit, maxChars) {
    if (!Array.isArray(value))
        return null;
    if (value.length > limit)
        return null;
    const result = [];
    for (const item of value) {
        if (typeof item !== 'string')
            return null;
        result.push(item.slice(0, maxChars));
    }
    return result;
}
function asEnv(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return {};
    const result = {};
    let count = 0;
    for (const [name, raw] of Object.entries(value)) {
        if (count >= MAX_ENV_ENTRIES)
            break;
        if (!ENV_NAME.test(name))
            continue;
        if (typeof raw !== 'string')
            continue;
        result[name] = raw.slice(0, MAX_ENV_VALUE_CHARS);
        count += 1;
    }
    return result;
}
function parseProfile(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    const record = raw;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!PROFILE_ID.test(id))
        return null;
    const command = typeof record.command === 'string' ? record.command.trim() : '';
    if (!command || command.length > 500)
        return null;
    const args = asStringArray(record.args ?? [], MAX_ARGS, MAX_ARG_CHARS);
    if (args === null)
        return null;
    let cwd = null;
    if (typeof record.cwd === 'string' && record.cwd.trim()) {
        const resolved = path.resolve(record.cwd.trim());
        try {
            if (!fs.statSync(resolved).isDirectory())
                return null;
            cwd = resolved;
        }
        catch {
            return null;
        }
    }
    const policy = record.policy === 'workspace'
        ? 'workspace'
        : (record.policy === 'ask' ? 'ask' : 'read-only');
    const timeoutSeconds = typeof record.timeoutSeconds === 'number' && Number.isFinite(record.timeoutSeconds)
        ? Math.max(5, Math.min(1800, Math.round(record.timeoutSeconds)))
        : 120;
    const label = typeof record.label === 'string' && record.label.trim()
        ? record.label.trim().slice(0, 100)
        : id;
    return { id, label, command, args, cwd, policy, timeoutSeconds, env: asEnv(record.env) };
}
export function loadPeerProfiles() {
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(peerProfilesPath(), 'utf8'));
    }
    catch {
        return [];
    }
    let entries;
    if (Array.isArray(raw)) {
        entries = raw;
    }
    else if (raw !== null && typeof raw === 'object' && Array.isArray(raw.peers)) {
        entries = raw.peers;
    }
    else {
        return [];
    }
    const profiles = [];
    const seen = new Set();
    for (const entry of entries) {
        if (profiles.length >= MAX_PEERS)
            break;
        const profile = parseProfile(entry);
        if (!profile || seen.has(profile.id))
            continue;
        seen.add(profile.id);
        profiles.push(profile);
    }
    return profiles;
}
export function savePeerProfiles(profiles) {
    const file = peerProfilesPath();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const content = {
        schemaVersion: 1,
        peers: profiles
    };
    fs.writeFileSync(file, JSON.stringify(content, null, 2), 'utf8');
}
export function addPeerProfile(profile) {
    const current = loadPeerProfiles();
    const idx = current.findIndex((p) => p.id === profile.id);
    if (idx >= 0) {
        current[idx] = profile;
    }
    else {
        if (current.length >= MAX_PEERS) {
            return { ok: false, error: `Maximum of ${MAX_PEERS} peer profiles exceeded.` };
        }
        current.push(profile);
    }
    try {
        savePeerProfiles(current);
        return { ok: true };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
    }
}
export function removePeerProfile(id) {
    const current = loadPeerProfiles();
    const filtered = current.filter((p) => p.id !== id);
    if (filtered.length === current.length) {
        return { ok: false, error: `Peer profile "${id}" is not configured.` };
    }
    try {
        savePeerProfiles(filtered);
        return { ok: true };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
    }
}
/**
 * Resolves a peer profile by ID. Checks user configuration first;
 * if not found, falls back to built-in agent presets.
 */
export function getPeerProfile(id) {
    const normalizedId = String(id || '').trim().toLowerCase();
    const configured = loadPeerProfiles().find((profile) => profile.id.toLowerCase() === normalizedId);
    if (configured)
        return configured;
    // Fallback to built-in presets (e.g. opencode, claude, codex, hermes, cursor, gemini)
    return getPresetProfile(normalizedId);
}
/**
 * Returns all available peers: user configured peers plus all built-in presets
 * that are not already shadowed by a user profile.
 */
export function listAllPeers() {
    const userPeers = loadPeerProfiles();
    const userIds = new Set(userPeers.map((p) => p.id.toLowerCase()));
    const all = [...userPeers];
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
export function peerEnvironment(profile) {
    const env = {};
    for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SYSTEMROOT']) {
        const value = process.env[name];
        if (typeof value === 'string')
            env[name] = value;
    }
    for (const [name, value] of Object.entries(profile.env))
        env[name] = value;
    return env;
}
