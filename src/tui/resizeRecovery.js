/** A temporary small terminal must not permanently discard the live surface. */
export function settleStageResize(current, suspended) {
    if (current) {
        return current.resize()
            ? { current, suspended: null, restored: false }
            : { current: null, suspended: current, restored: false };
    }
    if (suspended) {
        suspended.resize();
        if (suspended.stage.maxHeight > 0 && suspended.open()) {
            return { current: suspended, suspended: null, restored: true };
        }
    }
    return { current: null, suspended, restored: false };
}
