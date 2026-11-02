export interface ConsoleGuardStageHost {
  out?: NodeJS.WriteStream | { rows?: number; columns?: number };
  stage?: { reserved?: boolean; invalidate?: () => void };
}

export interface TransientNoticeHost {
  notice: string;
  scheduleDraw(): void;
}

const activeStageHosts = new Set<ConsoleGuardStageHost>();
let stageMouseSessionDepth = 0;
let guardInstalled = false;

const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};

export function isAnyStageReservedOnStdout(): boolean {
  if (stageMouseSessionDepth > 0 && process.stdout?.isTTY) {
    return true;
  }
  for (const host of activeStageHosts) {
    if (host.stage?.reserved && (!host.out || host.out === process.stdout)) {
      return true;
    }
  }
  return false;
}

function ensureConsoleGuardInstalled(): void {
  if (guardInstalled) return;
  guardInstalled = true;

  const wrap = (fn: (...args: unknown[]) => void) => (...args: unknown[]): void => {
    if (isAnyStageReservedOnStdout()) {
      // Never write raw console output while the full-screen TUI Stage owns stdout,
      // because the terminal cursor rests inside the composer input box and raw
      // writes corrupt the composer rows and shift the physical cursor.
      return;
    }
    fn(...args);
  };

  console.log = wrap(originalConsole.log);
  console.info = wrap(originalConsole.info);
  console.warn = wrap(originalConsole.warn);
  console.error = wrap(originalConsole.error);
}

/**
 * Track TUI Stage open/close lifecycle so raw console writes cannot corrupt the composer box.
 */
export function setStageConsoleGuardActive(active: boolean): void {
  ensureConsoleGuardInstalled();
  if (active) {
    stageMouseSessionDepth = Math.max(1, stageMouseSessionDepth + 1);
  } else {
    stageMouseSessionDepth = Math.max(0, stageMouseSessionDepth - 1);
  }
}

/**
 * Register a StageSurface host so raw console writes are suppressed while its Stage is reserved.
 */
export function registerStageConsoleGuard(host: ConsoleGuardStageHost): () => void {
  ensureConsoleGuardInstalled();
  activeStageHosts.add(host);
  return () => {
    activeStageHosts.delete(host);
  };
}

const noticeTimers = new WeakMap<TransientNoticeHost, ReturnType<typeof setTimeout>>();

/**
 * Set a transient status notice on the prompt/composer host and auto-clear it after `ttlMs`
 * if nothing else has overwritten `host.notice` in the meantime.
 */
export function setTransientNotice(host: TransientNoticeHost, message: string, ttlMs = 4000): void {
  const existing = noticeTimers.get(host);
  if (existing) {
    clearTimeout(existing);
    noticeTimers.delete(host);
  }
  host.notice = message;
  host.scheduleDraw();
  if (!message || ttlMs <= 0) return;

  const timer = setTimeout(() => {
    noticeTimers.delete(host);
    if (host.notice === message) {
      host.notice = '';
      host.scheduleDraw();
    }
  }, ttlMs);
  timer.unref?.();
  noticeTimers.set(host, timer);
}
