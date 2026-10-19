// "Allow always" — standing approvals, for the length of this process only.
//
// WHY THIS EXISTS. Being asked to approve the same tool for the twentieth time
// in one task does not make anyone safer; it makes them stop reading and start
// hammering the approve key, which is the exact failure the gate exists to
// prevent. A gate people are numb to is not a gate. So the honest answer is to
// let someone who has decided a tool is fine say so once, deliberately.
//
// THE SCOPE IS THE PROCESS, AND THAT IS THE WHOLE SAFETY MODEL.
// This is a module-level Set. It is never written to config.json, never

// approval is gone — the same contract opencode states to the user in its own
// words: "This will allow … until OpenCode is restarted."
//
// Persisting these to disk would be a different feature with a different risk
// profile: a permission granted in a hurry six weeks ago, silently applying to
// a session the user has forgotten they configured. If that is ever wanted it
// should be an explicit, listed, revocable config entry — not a quiet
// side-effect of a keypress in a modal.

/** Tool names approved for the rest of this process. Deliberately in memory. */
const standingApprovals = new Set();

/**
 * Record a standing approval for one tool.
 *
 * @param {string} toolName  Canonical tool name, e.g. 'sysRun'.
 */
export function grantAlways(toolName) {
  const name = String(toolName || '').trim();
  if (name) standingApprovals.add(name);
}

/**
 * True when this tool may run without asking again.
 *
 * @param {string} toolName
 * @returns {boolean}
 */
export function isAlwaysAllowed(toolName) {
  return standingApprovals.has(String(toolName || '').trim());
}

/** Every standing approval, for `/approvals` and for the audit trail. */
export function listAlwaysAllowed() {
  return [...standingApprovals].sort();
}

/**
 * Take them all back.
 *
 * A grant with no way out is a trap, so this is reachable from `/approvals
 * clear` as well as from a restart.
 *
 * @returns {number} how many were revoked
 */
export function revokeAllAlways() {
  const count = standingApprovals.size;
  standingApprovals.clear();
  return count;
}

/** Revoke one. @returns {boolean} true when there was something to revoke. */
export function revokeAlways(toolName) {
  return standingApprovals.delete(String(toolName || '').trim());
}
