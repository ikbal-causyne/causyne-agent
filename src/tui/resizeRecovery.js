/** A temporary small terminal must not permanently discard the live surface. */
export function settleStageResize(current, suspended) {
    if (current) {
        if (current.resize())
            return { current, suspended: null, restored: false };
        // A surface may close without updating its old ceiling. Do not reopen it
        // using stale geometry while the terminal remains below the minimum.
        current.stage.maxHeight = 0;
        return { current: null, suspended: current, restored: false };
    }
    if (suspended) {
        suspended.resize();
        if (suspended.stage.maxHeight > 0 && suspended.open()) {
            return { current: suspended, suspended: null, restored: true };
        }
    }
    return { current: null, suspended, restored: false };
}
