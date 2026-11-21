// Consent state for capability groups, readable without loading the installer.
//
// Three states matter and only three: granted (true), declined (false), and
// never asked (absent). Collapsing "declined" into "not granted" would make the
// agent re-ask forever, which is how a consent prompt becomes noise the user
// learns to dismiss.

import { loadConfig } from '../config.js';

const FORBIDDEN_CONSENT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const GROUP_KEY_RE = /^[a-z][a-z0-9_-]{0,63}$/;

export function isValidGroupKey(group: unknown): group is string {
  return typeof group === 'string' && GROUP_KEY_RE.test(group) && !FORBIDDEN_CONSENT_KEYS.has(group);
}

export function consentMap(): Record<string, boolean> {
  const clean: Record<string, boolean> = Object.create(null);
  try {
    const raw = loadConfig()?.capabilityConsent;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return clean;
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
      if (FORBIDDEN_CONSENT_KEYS.has(key) || !GROUP_KEY_RE.test(key)) continue;
      if (typeof val === 'boolean') clean[key] = val;
    }
    return clean;
  } catch {
    return clean;
  }
}

export function isGroupGranted(group: string): boolean {
  if (typeof group !== 'string' || !GROUP_KEY_RE.test(group) || FORBIDDEN_CONSENT_KEYS.has(group)) return false;
  const map = consentMap();
  return Object.hasOwn(map, group) && map[group] === true;
}

export function isGroupDeclined(group: string): boolean {
  if (typeof group !== 'string' || !GROUP_KEY_RE.test(group) || FORBIDDEN_CONSENT_KEYS.has(group)) return false;
  const map = consentMap();
  return Object.hasOwn(map, group) && map[group] === false;
}
