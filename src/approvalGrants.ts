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
// serialized, and never restored. When the process ends, every standing
// approval is gone — the same contract opencode states to the user in its own
// words: "This will allow … until OpenCode is restarted."
//
// Persisting these to disk would be a different feature with a different risk
// profile: a permission granted in a hurry six weeks ago, silently applying to
// a session the user has forgotten they configured. If that is ever wanted it
// should be an explicit, listed, revocable config entry — not a quiet
// side-effect of a keypress in a modal.

/**
 * One set of standing approvals, isolated from every other scope.
 *
 * The process-wide scope below is what a terminal session uses. A server-owned
 * conversation (ACP) gets its own scope instead, so "allow always" in one
 * conversation can never leak into another one — and never into a fork, which
 * starts with a scope that has never been granted anything.
 */
export interface ApprovalScope {
  grantAlways(toolName: unknown): void;
  isAlwaysAllowed(toolName: unknown): boolean;
  listAlwaysAllowed(): string[];
  revokeAllAlways(): number;
  revokeAlways(toolName: unknown): boolean;
}

/** Tool names approved for the rest of this process. Deliberately in memory. */
const standingApprovals = new Set<string>();

function normalizeToolName(toolName: unknown): string {
  return String(toolName || '').trim();
}

/** Record a standing approval for one canonical tool name. */
export function grantAlways(toolName: unknown): void {
  const name = normalizeToolName(toolName);
  if (name) standingApprovals.add(name);
}

/** True when this tool may run without asking again. */
export function isAlwaysAllowed(toolName: unknown): boolean {
  return standingApprovals.has(normalizeToolName(toolName));
}

/** Every standing approval, for `/approvals` and for the audit trail. */
export function listAlwaysAllowed(): string[] {
  return [...standingApprovals].sort();
}

/** Take every standing approval back and return how many were revoked. */
export function revokeAllAlways(): number {
  const count = standingApprovals.size;
  standingApprovals.clear();
  return count;
}

/** Revoke one standing approval. */
export function revokeAlways(toolName: unknown): boolean {
  return standingApprovals.delete(normalizeToolName(toolName));
}

/** A fresh, empty standing-approval scope that is not shared with anything. */
export function createApprovalScope(): ApprovalScope {
  const approvals = new Set<string>();
  return {
    grantAlways(toolName) {
      const name = normalizeToolName(toolName);
      if (name) approvals.add(name);
    },
    isAlwaysAllowed(toolName) {
      return approvals.has(normalizeToolName(toolName));
    },
    listAlwaysAllowed() {
      return [...approvals].sort();
    },
    revokeAllAlways() {
      const count = approvals.size;
      approvals.clear();
      return count;
    },
    revokeAlways(toolName) {
      return approvals.delete(normalizeToolName(toolName));
    }
  };
}

/** The process-wide scope, for callers that do not create their own. */
export const processApprovalScope: ApprovalScope = {
  grantAlways,
  isAlwaysAllowed,
  listAlwaysAllowed,
  revokeAllAlways,
  revokeAlways
};
