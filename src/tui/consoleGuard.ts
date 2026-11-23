import { safeDisplay } from './text.js';

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
const MAX_CAPTURED_STAGE_DIAGNOSTICS = 64;
const suppressedStageDiagnostics: string[] = [];

function recordSuppressedDiagnostic(source: string, rawText: string): void {
  const clean = safeDisplay(rawText).replace(/\s+/g, ' ').trim();
  if (!clean) return;
  suppressedStageDiagnostics.push(`[${source}] ${clean.slice(0, 400)}`);
  if (suppressedStageDiagnostics.length > MAX_CAPTURED_STAGE_DIAGNOSTICS) {
    suppressedStageDiagnostics.splice(0, suppressedStageDiagnostics.length - MAX_CAPTURED_STAGE_DIAGNOSTICS);
  }
}

export function peekSuppressedStageDiagnostics(): string[] {
  return [...suppressedStageDiagnostics];
}

export function drainSuppressedStageDiagnostics(): string[] {
  return suppressedStageDiagnostics.splice(0, suppressedStageDiagnostics.length);
}

const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};

const originalStderrWrite = process.stderr?.write
  ? process.stderr.write.bind(process.stderr)
  : null;

const originalStdoutWrite = process.stdout?.write
  ? process.stdout.write.bind(process.stdout)
  : null;

let stageInternalWriting = false;

/**
 * Run a write operation with permission to write to stdout during Stage sessions.
 *
 * Every TUI-owned terminal control write (Stage band diffs, OSC 52 clipboard sync,
 * StageSurface mouse mode toggles ?1000/?1006/?1003, and ChatPrompt bracketed
 * paste ?2004 / Ctrl+L clear) MUST execute inside runWithStageWrite(); otherwise
 * the process.stdout guard drops escape sequences while a Stage is reserved.
 */
export function runWithStageWrite<T>(fn: () => T): T {
  const prev = stageInternalWriting;
  stageInternalWriting = true;
  try {
    return fn();
  } finally {
    stageInternalWriting = prev;
  }
}

function chunkToText(chunk: unknown, encodingOrCb?: unknown): string {
  if (typeof chunk === 'string') return chunk;
  const encoding: BufferEncoding =
    typeof encodingOrCb === 'string' && Buffer.isEncoding(encodingOrCb)
      ? encodingOrCb
      : 'utf8';
  if (Buffer.isBuffer(chunk)) return chunk.toString(encoding);
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString(encoding);
  return String(chunk ?? '');
}

export function isAnyStageReservedOnStdout(): boolean {
  if (stageMouseSessionDepth > 0 && process.stdout?.isTTY) {
    return true;
  }
  for (const host of activeStageHosts) {
    if (host?.stage?.reserved && (!host.out || host.out === process.stdout)) {
      return true;
    }
  }
  return false;
}

function ensureConsoleGuardInstalled(): void {
  if (guardInstalled) return;
  guardInstalled = true;

  const wrap = (label: string, fn: (...args: unknown[]) => void) => (...args: unknown[]): void => {
    if (isAnyStageReservedOnStdout()) {
      // Never write raw console output while the full-screen TUI Stage owns stdout,
      // because the terminal cursor rests inside the composer input box and raw
      // writes corrupt the composer rows and shift the physical cursor.
      recordSuppressedDiagnostic(label, args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' '));
      return;
    }
    fn(...args);
  };

  console.log = wrap('console.log', originalConsole.log);
  console.info = wrap('console.info', originalConsole.info);
  console.warn = wrap('console.warn', originalConsole.warn);
  console.error = wrap('console.error', originalConsole.error);

  if (originalStderrWrite && process.stderr) {
    process.stderr.write = ((chunk: unknown, encodingOrCb?: unknown, cb?: unknown): boolean => {
      if (isAnyStageReservedOnStdout()) {
        recordSuppressedDiagnostic('stderr', chunkToText(chunk, encodingOrCb));
        if (typeof encodingOrCb === 'function') (encodingOrCb as () => void)();
        else if (typeof cb === 'function') (cb as () => void)();
        return true;
      }
      return (originalStderrWrite as (...a: unknown[]) => boolean)(chunk, encodingOrCb, cb);
    }) as typeof process.stderr.write;
  }

  if (originalStdoutWrite && process.stdout) {
    process.stdout.write = ((chunk: unknown, encodingOrCb?: unknown, cb?: unknown): boolean => {
      if (isAnyStageReservedOnStdout() && !stageInternalWriting) {
        // Prevent any rogue unmanaged stdout writes from corrupting the active Stage rows/cursor
        const text = chunkToText(chunk, encodingOrCb);
        if (text.length > 0) {
          recordSuppressedDiagnostic('stdout', text);
          if (typeof encodingOrCb === 'function') (encodingOrCb as () => void)();
          else if (typeof cb === 'function') (cb as () => void)();
          return true;
        }
      }
      return (originalStdoutWrite as (...a: unknown[]) => boolean)(chunk, encodingOrCb, cb);
    }) as typeof process.stdout.write;
  }
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
  if (!host || typeof host !== 'object') return () => {};
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
  if (!host || typeof host !== 'object') return;
  const existing = noticeTimers.get(host);
  if (existing) {
    clearTimeout(existing);
    noticeTimers.delete(host);
  }
  const cleanMessage = typeof message === 'string' && message.length > 0
    ? safeDisplay(message).replace(/\s+/g, ' ').trim()
    : '';
  host.notice = cleanMessage;
  if (typeof host.scheduleDraw === 'function') host.scheduleDraw();
  const safeTtlMs = !Number.isFinite(ttlMs)
    ? (Number.isNaN(ttlMs) ? 4000 : 0)
    : Math.min(Math.floor(ttlMs), 2_147_483_647);
  if (!cleanMessage || safeTtlMs <= 0) return;

  const timer = setTimeout(() => {
    noticeTimers.delete(host);
    if (host.notice === cleanMessage) {
      host.notice = '';
      if (typeof host.scheduleDraw === 'function') host.scheduleDraw();
    }
  }, safeTtlMs);
  timer.unref?.();
  noticeTimers.set(host, timer);
}
