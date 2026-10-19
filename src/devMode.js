// The former Android entitlement emulator is retired. Keep this internal
// predicate while callers migrate to explicit local runtime budgets. Neither
// environment variables nor a hidden developer secret can bypass approvals.
export function isDevEmulator() {
  return false;
}
