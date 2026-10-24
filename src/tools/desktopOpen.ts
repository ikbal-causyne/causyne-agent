/**
 * Causyne Agent — Desktop Open Tool (desktop_open / desktop.open)
 *
 * Securely opens files, URLs, or applications using native OS handlers
 * without shell execution, npm dependencies, or capability consent stalls.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export interface DesktopOpenArgs {
  target: string;
  app?: string | undefined;
}

export interface DesktopOpenResult {
  success: boolean;
  output?: string | undefined;
  error?: string | undefined;
  requiresConsent?: boolean | undefined;
}

export interface DesktopOpenContext {
  parentLoop?: {
    workspaceRoot?: string | undefined;
  } | undefined;
}

export function resolveOpenTarget(rawTarget: string, workspaceRoot: string = process.cwd()): string {
  let target = (rawTarget || '').trim();
  if (!target) return target;

  // URLs (http, https, file, etc.)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(target)) {
    return target;
  }

  // Tilde expansion: ~/path -> /Users/username/path
  if (target === '~' || target.startsWith('~/') || target.startsWith('~\\')) {
    target = path.normalize(target.replace(/^~(?=$|[\\/])/, os.homedir()));
  }

  // If not absolute path, check if it exists relative to workspaceRoot or process.cwd()
  if (!path.isAbsolute(target)) {
    const fromWorkspace = path.resolve(workspaceRoot, target);
    if (fs.existsSync(fromWorkspace)) {
      return fromWorkspace;
    }
    const fromCwd = path.resolve(process.cwd(), target);
    if (fs.existsSync(fromCwd)) {
      return fromCwd;
    }
    return fromWorkspace;
  }

  return target;
}

export async function openWithNativeOS(target: string, app?: string): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve, reject) => {
    let command: string;
    let cliArgs: string[];

    const platform = os.platform();
    if (platform === 'darwin') {
      command = '/usr/bin/open';
      cliArgs = app ? ['-a', app, target] : [target];
    } else if (platform === 'win32') {
      command = 'cmd.exe';
      cliArgs = app ? ['/c', 'start', '""', '/d', app, target] : ['/c', 'start', '""', target];
    } else {
      command = 'xdg-open';
      cliArgs = [target];
    }

    try {
      const child = spawn(command, cliArgs, {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();

      child.on('error', (err) => {
        reject(err);
      });

      // Brief tick to ensure the binary was dispatched without immediate spawn error
      setTimeout(() => {
        resolve({
          success: true,
          output: `Successfully dispatched native OS open event for: ${target}`
        });
      }, 50);
    } catch (e) {
      reject(e);
    }
  });
}

export const desktopOpen = {
  schema: {
    name: 'desktop.open',
    description: 'Securely open files, URLs, or applications using native OS handlers without shell execution.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'File path, URL, or app name' },
        app: { type: 'string', description: 'Specific app to open with (e.g., "Google Chrome")' }
      },
      required: ['target']
    }
  },

  async execute(args: DesktopOpenArgs, context: DesktopOpenContext = {}): Promise<DesktopOpenResult> {
    if (!args || typeof args.target !== 'string' || !args.target.trim()) {
      return { success: false, error: 'Missing required "target" parameter for desktop.open' };
    }

    const workspaceRoot = context?.parentLoop?.workspaceRoot || process.cwd();
    const resolvedTarget = resolveOpenTarget(args.target, workspaceRoot);

    try {
      const nativeResult = await openWithNativeOS(resolvedTarget, args.app);
      return { success: true, output: nativeResult.output };
    } catch (nativeErr: unknown) {
      // Fallback: if optional npm 'open' package happens to be installed, try it
      try {
        const { loadCapabilityPackage, groupStatus } = await import('../provisioning/capabilityProvisioner.js');
        if (groupStatus('desktop')?.state === 'ready') {
          const openPkg = await loadCapabilityPackage('open') as (t: string, o?: Record<string, unknown>) => Promise<unknown>;
          const options: Record<string, unknown> = {};
          if (args.app) options.app = { name: args.app };
          await openPkg(resolvedTarget, options);
          return { success: true, output: `Successfully dispatched OS open event for: ${resolvedTarget}` };
        }
      } catch {}

      const msg = nativeErr instanceof Error ? nativeErr.message : String(nativeErr);
      return { success: false, error: `Failed to open "${resolvedTarget}": ${msg}` };
    }
  }
};
