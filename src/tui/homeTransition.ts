interface HomeLoop {
  memoryManager?: { startNewSession: (title: string) => unknown };
  messages: unknown[];
  tokenTracker?: { reset?: () => void };
}

/** Preserve a chosen session; a direct first prompt starts fresh. */
export class HomeTransition {
  private started = false;
  private readonly openedHome: boolean;
  private readonly surface: { homeSessionSelected?: boolean; leaveHome?: () => void } | null;

  constructor(openedHome: boolean, surface: { homeSessionSelected?: boolean; leaveHome?: () => void } | null) {
    this.openedHome = openedHome;
    this.surface = surface;
  }

  beginTurn(loop: HomeLoop): void {
    if (!this.openedHome || this.started) return;
    this.started = true;
    if (this.surface?.homeSessionSelected) return;
    this.surface?.leaveHome?.();
    loop.memoryManager?.startNewSession('Untitled');
    loop.messages = [];
    loop.tokenTracker?.reset?.();
  }
}
