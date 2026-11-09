/**
 * Wait for a retry delay without retaining an AbortSignal listener afterwards.
 *
 * A native AbortSignal is also checked after listener registration; otherwise
 * an abort occurring between the initial check and registration can be missed.
 * The timer is kept referenced while the retry is pending so a CLI process does
 * not exit with an unresolved task solely because there are no other handles.
 */
export function waitForAbortableDelay(
  durationMs: number,
  signal?: AbortSignal | null
): Promise<'elapsed' | 'aborted'> {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return Promise.reject(new RangeError('Backoff duration must be a finite, nonnegative number'));
  }
  if (signal?.aborted) return Promise.resolve('aborted');
  if (durationMs === 0) return Promise.resolve('elapsed');

  return new Promise<'elapsed' | 'aborted'>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (outcome: 'elapsed' | 'aborted'): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => finish('aborted');

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      finish('aborted');
      return;
    }
    timer = setTimeout(() => finish('elapsed'), durationMs);
  });
}
