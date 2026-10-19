// Consent state for capability groups, readable without loading the installer.
//
// Three states matter and only three: granted (true), declined (false), and
// never asked (absent). Collapsing "declined" into "not granted" would make the
// agent re-ask forever, which is how a consent prompt becomes noise the user
// learns to dismiss.

import { loadConfig } from '../config.js';

export function consentMap() {
  try {
    return loadConfig().capabilityConsent || {};
  } catch (e) {
    return {};
  }
}

export function isGroupGranted(group) {
  return consentMap()[group] === true;
}

export function isGroupDeclined(group) {
  return consentMap()[group] === false;
}
