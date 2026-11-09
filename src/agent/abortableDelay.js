/**
 * Wait for a retry delay without retaining an AbortSignal listener afterwards.
 *
 * A native AbortSignal is also checked after listener registration; otherwise
 * an abort occurring between the initial check and registration can be missed.
 * The timer is kept referenced while the retry is pending so a CLI process does
 * not exit with an unresolved task solely because there are no other handles.
 */
export function waitForAbortableDelay(durationMs, signal) {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
        return Promise.reject(new RangeError('Backoff duration must be a finite, nonnegative number'));
    }
    if (signal?.aborted)
        return Promise.resolve('aborted');
    if (durationMs === 0)
        return Promise.resolve('elapsed');
    return new Promise((resolve) => {
        let timer;
        let settled = false;
        const finish = (outcome) => {
            if (settled)
                return;
            settled = true;
            if (timer !== undefined)
                clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve(outcome);
        };
        const onAbort = () => finish('aborted');
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) {
            finish('aborted');
            return;
        }
        timer = setTimeout(() => finish('elapsed'), durationMs);
    });
}
