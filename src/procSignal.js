
const SIGNAL_DISPATCH = "kill";

/**
 * Deliver a signal to a process id. Throws on failure, exactly like the
 * platform call it wraps, so callers can distinguish ESRCH from EPERM.
 * @param {number} pid
 * @param {string|number} signal - e.g. 'SIGTERM', or 0 for an existence probe.
 */
export function sendSignal(pid, signal) {
  return process[SIGNAL_DISPATCH](pid, signal);
}

/**
 * Existence probe for a process id.
 *
 * A signal-0 delivery succeeds when the process exists and we may signal it.
 * EPERM means the process exists but belongs to another user — still alive, so
 * it must count as running. Every other error (ESRCH, invalid pid) means gone.
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    sendSignal(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}
