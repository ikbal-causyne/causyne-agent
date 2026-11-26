/**
 * Process-scoped launcher for Causyne Local Skybridge GUI (`/gui`, `causyne web`).
 *
 * Strictly loopback-only (`127.0.0.1`), 256-bit session nonce authenticated,
 * locked to the active workspace, and torn down cleanly on `/gui stop`, `/cd`,
 * or CLI shutdown. Never spawns a persistent background daemon.
 */
import fs from 'node:fs';
import path from 'node:path';
import { startSkybridgeServer } from './skybridgeServer.js';
import { openBrowserUrl } from '../utils/browserOpen.js';
import { writeClipboardSync } from '../tui/clipboardSync.js';
let activeGuiHandle = null;
export function getGuiServerStatus() {
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
export async function stopGuiServer() {
    const handle = activeGuiHandle;
    activeGuiHandle = null;
    if (!handle)
        return false;
    await handle.close();
    return true;
}
function normalizeWorkspacePath(dir) {
    const resolved = path.resolve(dir);
    try {
        return typeof fs.realpathSync.native === 'function'
            ? fs.realpathSync.native(resolved)
            : fs.realpathSync(resolved);
    }
    catch {
        return resolved;
    }
}
export async function launchGuiServer(options = {}) {
    const targetWorkspace = normalizeWorkspacePath(options.workspaceRoot || process.cwd());
    const requestedPort = typeof options.port === 'number' && Number.isInteger(options.port) && options.port >= 0 && options.port <= 65535
        ? options.port
        : 0;
    const openFn = options.opener ?? ((url) => openBrowserUrl(url, { noOpen: options.openBrowser === false }));
    let handle;
    let reused = false;
    if (activeGuiHandle) {
        const sameWorkspace = normalizeWorkspacePath(activeGuiHandle.workspaceRoot) === targetWorkspace;
        const samePort = requestedPort === 0 || activeGuiHandle.port === requestedPort;
        if (sameWorkspace && samePort) {
            handle = activeGuiHandle;
            reused = true;
        }
        else {
            await stopGuiServer();
            handle = await startSkybridgeServer({ workspaceRoot: targetWorkspace, port: requestedPort });
            activeGuiHandle = handle;
        }
    }
    else {
        handle = await startSkybridgeServer({ workspaceRoot: targetWorkspace, port: requestedPort });
        activeGuiHandle = handle;
    }
    const openResult = options.openBrowser === false
        ? { opened: false, reason: 'disabled' }
        : await Promise.resolve(openFn(handle.url));
    let copiedToClipboard = false;
    if (options.copyToClipboard !== false && process.env.CI !== 'true' && process.env.CI !== '1' && process.env.NODE_ENV !== 'test') {
        try {
            copiedToClipboard = Boolean(writeClipboardSync(handle.url));
        }
        catch {
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
