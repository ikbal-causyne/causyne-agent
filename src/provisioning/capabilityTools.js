// Which catalogue tools depend on which capability group.
//
// Kept separate from capabilityProvisioner.js so that registry.js — which runs
// on every single LLM call — can consult it without pulling in the install
// machinery, the config vault, or execSafe.
//
// A tool appears here only when the capability is REQUIRED for it to do
// anything. fs_delete is deliberately absent: it prefers the OS recycle bin but
// has a real safe-rename fallback, so it works with no capability at all.

import { isGroupDeclined } from './capabilityConsent.js';

export const TOOLS_BY_GROUP = {
  vision: ['browser_act', 'screenshot', 'vision_inspect_ui', 'game_canvas_audit', 'game_web_runtime_inspector'],
  ocr: [],
  system: ['process_list'],
  desktop: ['clipboard', 'desktop_open'],
  archive: ['archive']
};

/** Catalogue names the user has explicitly declined the capability for. */
export function declinedToolNames() {
  const declined = new Set();
  for (const [group, tools] of Object.entries(TOOLS_BY_GROUP)) {
    if (!isGroupDeclined(group)) continue;
    for (const name of tools) declined.add(name);
  }
  return declined;
}
