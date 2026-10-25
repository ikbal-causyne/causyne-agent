/** Preserve a chosen session; a direct first prompt starts fresh. */
export class HomeTransition {
    started = false;
    openedHome;
    surface;
    constructor(openedHome, surface) {
        this.openedHome = openedHome;
        this.surface = surface;
    }
    beginTurn(loop) {
        if (!this.openedHome || this.started)
            return;
        this.started = true;
        if (this.surface?.homeSessionSelected)
            return;
        this.surface?.leaveHome?.();
        loop.memoryManager?.startNewSession('Untitled');
        loop.messages = [];
        loop.tokenTracker?.reset?.();
    }
}
