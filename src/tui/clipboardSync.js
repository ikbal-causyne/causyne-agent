// Sovereign Synchronous Clipboard Reader for TUI prompts & modal dialogs.
// Supports macOS (pbpaste), Windows (powershell Get-Clipboard), Linux (wl-paste, xclip, xsel),
// and terminal emulator OSC 52 escape sequences across SSH and local sessions.
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import { runWithStageWrite } from './consoleGuard.js';
export function isWslEnvironment(platform = process.platform, release = os.release(), env = process.env) {
    if (platform !== 'linux')
        return false;
    if (typeof env.WSL_DISTRO_NAME === 'string' && env.WSL_DISTRO_NAME.trim().length > 0)
        return true;
    if (typeof env.WSL_INTEROP === 'string' && env.WSL_INTEROP.trim().length > 0)
        return true;
    const lower = String(release || '').toLowerCase();
    return lower.includes('microsoft') || lower.includes('wsl');
}
const PS_READ_UTF8_CLIPBOARD = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $v = Get-Clipboard -Raw; if ($null -ne $v) { [Console]::Out.Write($v) }';
const PS_WRITE_UTF8_CLIPBOARD = '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())';
/**
 * Emit OSC 52 escape sequence to synchronize terminal emulator clipboard.
 * Allows copy/paste even across SSH sessions, tmux, and container boundaries.
 */
export function emitOsc52Copy(text, stream = process.stdout) {
    if (typeof text !== 'string' || text.length === 0 || Buffer.byteLength(text) > 100_000)
        return false;
    if (!stream || typeof stream.write !== 'function')
        return false;
    if (stream === process.stdout && !process.stdout?.isTTY)
        return false;
    try {
        const base64 = Buffer.from(text, 'utf8').toString('base64');
        const payload = `\x1b]52;c;${base64}\x07`;
        if (stream === process.stdout) {
            runWithStageWrite(() => stream.write(payload));
        }
        else {
            stream.write(payload);
        }
        return true;
    }
    catch {
        return false;
    }
}
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
            return execFileSync('powershell.exe', ['-NonInteractive', '-NoProfile', '-Command', PS_READ_UTF8_CLIPBOARD], {
                encoding: 'utf8',
                timeout: 1500,
                windowsHide: true
            }).replace(/\r\n$/, '');
        }
        if (process.platform === 'linux') {
            try {
                return execFileSync('wl-paste', ['--no-newline'], { encoding: 'utf8', timeout: 500 });
            }
            catch {
                try {
                    return execFileSync('xclip', ['-selection', 'clipboard', '-o'], {
                        encoding: 'utf8',
                        timeout: 500
                    });
                }
                catch {
                    try {
                        return execFileSync('xsel', ['--clipboard', '--output'], {
                            encoding: 'utf8',
                            timeout: 500
                        });
                    }
                    catch {
                        if (isWslEnvironment()) {
                            return execFileSync('powershell.exe', ['-NonInteractive', '-NoProfile', '-Command', PS_READ_UTF8_CLIPBOARD], {
                                encoding: 'utf8',
                                timeout: 1500,
                                windowsHide: true
                            }).replace(/\r\n$/, '');
                        }
                    }
                }
            }
        }
    }
    catch {
        // Clipboard reading is best-effort: never crash the TUI on failure
    }
    return '';
}
/** Write text through stdin, never through a shell or a command argument. */
export function writeClipboardSync(value) {
    if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 4_000_000)
        return false;
    // Emit OSC 52 to synchronize host terminal clipboard (local & SSH)
    emitOsc52Copy(value);
    const candidates = process.platform === 'darwin'
        ? [['pbcopy', []]]
        : process.platform === 'win32'
            ? [['powershell.exe', ['-NonInteractive', '-NoProfile', '-Command', PS_WRITE_UTF8_CLIPBOARD]]]
            : process.platform === 'linux'
                ? [
                    ['wl-copy', []],
                    ['xclip', ['-selection', 'clipboard', '-i']],
                    ['xsel', ['--clipboard', '--input']],
                    ...(isWslEnvironment() ? [['powershell.exe', ['-NonInteractive', '-NoProfile', '-Command', PS_WRITE_UTF8_CLIPBOARD]]] : [])
                ]
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
            if (!result.error && result.status === 0)
                return true;
        }
        catch { /* Try the next available clipboard provider. */ }
    }
    return false;
}
