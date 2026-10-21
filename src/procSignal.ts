const SIGNAL_DISPATCH = 'kill' as const;

/**
 * Deliver a signal to a process id. Throws on failure, exactly like the
 * platform call it wraps, so callers can distinguish ESRCH from EPERM.
 * @param pid
 * @param signal - e.g. 'SIGTERM', or 0 for an existence probe.
 */
export function sendSignal(pid: number, signal: string | number): true {
  return process[SIGNAL_DISPATCH](pid, signal as NodeJS.Signals | number);
}

/**
 * Existence probe for a process id.
 *
 * A signal-0 delivery succeeds when the process exists and we may signal it.
 * EPERM means the process exists but belongs to another user — still alive, so
 * it must count as running. Every other error (ESRCH, invalid pid) means gone.
 *
 * @param pid
 * @returns boolean indicating if the process is alive.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    sendSignal(pid, 0);
    return true;
  } catch (e: unknown) {
    return (e as { code?: string })?.code === 'EPERM';
  }
}
