/**
 * Terminal-wide motion reports (?1003h) allow hover feedback, but hijack native mouse selection.
 * Disabled by default so users can freely select, drag, and copy text in the terminal.
 * Opt-in via CAUSYNE_MOUSE_HOVER=1.
 */
export function mouseHoverTracking(enabled: boolean, env: NodeJS.ProcessEnv = process.env): string {
  if (String(env.CAUSYNE_MOUSE_HOVER ?? '0') !== '1') return '';
  return enabled ? '\x1b[?1003h' : '\x1b[?1003l';
}

