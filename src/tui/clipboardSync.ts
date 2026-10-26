// Sovereign Synchronous Clipboard Reader for TUI prompts & modal dialogs.
// Supports macOS (pbpaste), Windows (powershell Get-Clipboard), and Linux (wl-paste, xclip).

import { execFileSync, spawnSync } from 'node:child_process';

/**
 * Read system clipboard text synchronously without hanging or throwing.
 * Returns empty string if clipboard is empty, unavailable, or unsupported.
 */
export function readClipboardSync(): string {
  try {
    if (process.platform === 'darwin') {
      return execFileSync('pbpaste', { encoding: 'utf8', timeout: 500 });
    }
    if (process.platform === 'win32') {
      return execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard'], {
        encoding: 'utf8',
        timeout: 1000,
        windowsHide: true
      });
    }
    if (process.platform === 'linux') {
      try {
        return execFileSync('wl-paste', { encoding: 'utf8', timeout: 500 });
      } catch {
        return execFileSync('xclip', ['-selection', 'clipboard', '-o'], {
          encoding: 'utf8',
          timeout: 500
        });
      }
    }
  } catch {
    // Clipboard reading is best-effort: never crash the TUI on failure
  }
  return '';
}

/** Write text through stdin, never through a shell or a command argument. */
export function writeClipboardSync(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 4_000_000) return false;
  const candidates: Array<[string, string[]]> = process.platform === 'darwin'
    ? [['pbcopy', []]]
    : process.platform === 'win32'
      ? [['powershell.exe', ['-NoProfile', '-Command', 'Set-Clipboard -Value ([Console]::In.ReadToEnd())']]]
      : process.platform === 'linux'
        ? [['wl-copy', []], ['xclip', ['-selection', 'clipboard', '-i']]]
        : [];
  for (const [command, args] of candidates) {
    try {
      const result = spawnSync(command, args, {
        input: value,
        encoding: 'utf8',
        timeout: 1500,
        windowsHide: true,
        maxBuffer: 64 * 1024
      });
      if (!result.error && result.status === 0) return true;
    } catch { /* Try the next available clipboard provider. */ }
  }
  return false;
}
