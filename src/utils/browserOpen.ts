/**
 * Safe, shell-free cross-platform browser URL opener with SSH / headless Linux / WSL guards.
 *
 * Strictly validates http:/https: URLs, never invokes a shell (`shell: false`),
 * avoids futile spawns in headless/SSH/CI environments, and returns actionable
 * fallback hints (such as SSH port-forwarding instructions for loopback URLs).
 */

import { spawn, type ChildProcess } from 'node:child_process';

export interface OpenBrowserOptions {
  noOpen?: boolean | undefined;
  platform?: NodeJS.Platform | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  spawnImpl?: typeof spawn | undefined;
}

export interface OpenBrowserResult {
  opened: boolean;
  reason?: 'disabled' | 'ci' | 'ssh' | 'headless' | 'invalid-url' | 'spawn-error' | undefined;
  hint?: string | undefined;
}

function isValidHttpUrl(rawUrl: string): URL | null {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed || /[\s\x00-\x1f\x7f]/.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed;
  } catch {
    return null;
  }
}

function isWslEnvironment(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
}

function isSshSession(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.SSH_CLIENT || env.SSH_TTY || env.SSH_CONNECTION);
}

function buildRemoteHint(parsed: URL): string {
  const host = parsed.hostname;
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  if (host === '127.0.0.1' || host === 'localhost') {
    return `Forward port from your local machine: ssh -L ${port}:127.0.0.1:${port} <user>@<host>`;
  }
  return `Open this URL in a browser: ${parsed.toString()}`;
}

export async function openBrowserUrl(
  rawUrl: string,
  options: OpenBrowserOptions = {}
): Promise<OpenBrowserResult> {
  const parsed = isValidHttpUrl(rawUrl);
  if (!parsed) {
    return { opened: false, reason: 'invalid-url' };
  }

  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  if (options.noOpen || env.CAUSYNE_NO_BROWSER === '1') {
    return { opened: false, reason: 'disabled' };
  }
  if (env.CI === 'true' || env.CI === '1' || env.NODE_ENV === 'test') {
    return { opened: false, reason: 'ci' };
  }

  const isWsl = platform === 'linux' && isWslEnvironment(env);
  if (isSshSession(env) && platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY && !isWsl) {
    return { opened: false, reason: 'ssh', hint: buildRemoteHint(parsed) };
  }
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY && !isWsl) {
    return { opened: false, reason: 'headless', hint: buildRemoteHint(parsed) };
  }

  let command: string;
  let args: string[];
  const safeUrl = parsed.toString();

  if (platform === 'darwin') {
    command = '/usr/bin/open';
    args = [safeUrl];
  } else if (platform === 'win32') {
    command = 'rundll32.exe';
    args = ['url.dll,FileProtocolHandler', safeUrl];
  } else if (isWsl) {
    command = 'wslview';
    args = [safeUrl];
  } else {
    command = 'xdg-open';
    args = [safeUrl];
  }

  const spawnFn = options.spawnImpl ?? spawn;
  try {
    const child: ChildProcess = spawnFn(command, args, {
      detached: true,
      stdio: 'ignore',
      shell: false,
      windowsHide: true
    });

    const earlyFailure = await new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (failed: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(failed);
      };
      child.once?.('error', () => done(true));
      child.once?.('exit', (code) => done(typeof code === 'number' && code !== 0));
      const timer = setTimeout(() => done(false), 120);
      timer.unref?.();
    });

    if (earlyFailure) {
      return { opened: false, reason: 'spawn-error', hint: buildRemoteHint(parsed) };
    }
    child.unref?.();
    return { opened: true };
  } catch {
    return { opened: false, reason: 'spawn-error', hint: buildRemoteHint(parsed) };
  }
}
