// Sovereign Synchronous Clipboard Reader for TUI prompts & modal dialogs.
// Supports macOS (pbpaste), Windows (powershell Get-Clipboard), and Linux (wl-paste, xclip).
import { execFileSync } from 'node:child_process';
/**
 * Read system clipboard text synchronously without hanging or throwing.
 * Returns empty string if clipboard is empty, unavailable, or unsupported.
 */
export function readClipboardSync() {
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
            }
            catch {
                return execFileSync('xclip', ['-selection', 'clipboard', '-o'], {
                    encoding: 'utf8',
                    timeout: 500
                });
            }
        }
    }
    catch {
        // Clipboard reading is best-effort: never crash the TUI on failure
    }
    return '';
}
