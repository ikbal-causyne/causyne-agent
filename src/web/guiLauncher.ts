/**
 * Process-scoped launcher for Causyne Local Skybridge GUI (`/gui`, `causyne web`).
 *
 * Strictly loopback-only (`127.0.0.1`), 256-bit session nonce authenticated,
 * locked to the active workspace, and torn down cleanly on `/gui stop`, `/cd`,
 * or CLI shutdown. Never spawns a persistent background daemon.
 */

import fs from 'node:fs';
import path from 'node:path';
import { startSkybridgeServer, type SkybridgeHandle } from './skybridgeServer.js';
import { openBrowserUrl, type OpenBrowserResult } from '../utils/browserOpen.js';
import { writeClipboardSync } from '../tui/clipboardSync.js';

export interface ActiveGuiStatus {
  running: boolean;
  url?: string | undefined;
  origin?: string | undefined;
  port?: number | undefined;
  workspaceRoot?: string | undefined;
}

export interface LaunchGuiOptions {
  workspaceRoot?: string | undefined;
  port?: number | undefined;
  openBrowser?: boolean | undefined;
  copyToClipboard?: boolean | undefined;
  opener?: ((url: string) => Promise<OpenBrowserResult> | OpenBrowserResult) | undefined;
}

export interface LaunchGuiResult {
  handle: SkybridgeHandle;
  reused: boolean;
  openedBrowser: boolean;
  browserHint?: string | undefined;
  copiedToClipboard: boolean;
}

let activeGuiHandle: SkybridgeHandle | null = null;

export function getGuiServerStatus(): ActiveGuiStatus {
  if (!activeGuiHandle) {
    return { running: false };
  }
  return {
    running: true,
    url: activeGuiHandle.url,
    origin: activeGuiHandle.origin,
    port: activeGuiHandle.port,
    workspaceRoot: activeGuiHandle.workspaceRoot
  };
}

export async function stopGuiServer(): Promise<boolean> {
  const handle = activeGuiHandle;
  activeGuiHandle = null;
  if (!handle) return false;
  await handle.close();
  return true;
}

function normalizeWorkspacePath(dir: string): string {
  const resolved = path.resolve(dir);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export async function launchGuiServer(options: LaunchGuiOptions = {}): Promise<LaunchGuiResult> {
  const targetWorkspace = normalizeWorkspacePath(options.workspaceRoot || process.cwd());
  const requestedPort = typeof options.port === 'number' && Number.isInteger(options.port) && options.port >= 0 && options.port <= 65535
    ? options.port
    : 0;
  const openFn = options.opener ?? ((url: string) => openBrowserUrl(url, { noOpen: options.openBrowser === false }));

  let handle: SkybridgeHandle;
  let reused = false;

  if (activeGuiHandle) {
    const sameWorkspace = normalizeWorkspacePath(activeGuiHandle.workspaceRoot) === targetWorkspace;
    const samePort = requestedPort === 0 || activeGuiHandle.port === requestedPort;
    if (sameWorkspace && samePort) {
      handle = activeGuiHandle;
      reused = true;
    } else {
      await stopGuiServer();
      handle = await startSkybridgeServer({ workspaceRoot: targetWorkspace, port: requestedPort });
      activeGuiHandle = handle;
    }
  } else {
    handle = await startSkybridgeServer({ workspaceRoot: targetWorkspace, port: requestedPort });
    activeGuiHandle = handle;
  }

  const openResult = options.openBrowser === false
    ? { opened: false as const, reason: 'disabled' as const }
    : await Promise.resolve(openFn(handle.url));

  let copiedToClipboard = false;
  if (options.copyToClipboard !== false && process.env.CI !== 'true' && process.env.CI !== '1' && process.env.NODE_ENV !== 'test') {
    try {
      copiedToClipboard = Boolean(writeClipboardSync(handle.url));
    } catch {
      copiedToClipboard = false;
    }
  }

  return {
    handle,
    reused,
    openedBrowser: openResult.opened,
    browserHint: openResult.hint,
    copiedToClipboard
  };
}
