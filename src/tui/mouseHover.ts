/** Terminal-wide motion reports allow hover feedback; opt out for native text selection. */
export function mouseHoverTracking(enabled: boolean, env: NodeJS.ProcessEnv = process.env): string {
  if (String(env.CAUSYNE_MOUSE_HOVER ?? '1') === '0') return '';
  return enabled ? '\x1b[?1003h' : '\x1b[?1003l';
}
