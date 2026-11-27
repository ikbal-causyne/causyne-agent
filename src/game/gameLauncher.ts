/**
 * Process-scoped launcher for Causyne Game (`/game`, `causyne game`, and Web Studio).
 *
 * Launches the separate Causyne Game browser workspace strictly on localhost
 * (`127.0.0.1`), injects `CAUSYNE_BIN` pointing directly to this Causyne Agent
 * installation so Causyne Agent operates as Causyne Game's primary agent, waits
 * for `/api/health`, opens the browser via hardened `openBrowserUrl()`, and
 * shuts down cleanly on `/game stop` or CLI exit (zero hidden daemons).
 */

import fsSync from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openBrowserUrl, type OpenBrowserResult } from '../utils/browserOpen.js';
import { writeClipboardSync } from '../tui/clipboardSync.js';
import {
  defaultGameManifestUrl,
  gameDataDir,
  locateGameStudio,
  type GameInstallSource,
  type LocatedGameStudio
} from './gameProvisioner.js';
import {
  startCausyneCoreBridge,
  type CausyneCoreBridgeHandle
} from './causyneCoreBridge.js';

export interface ActiveGameStudioStatus {
  running: boolean;
  url?: string | undefined;
  origin?: string | undefined;
  port?: number | undefined;
  dir?: string | undefined;
  source?: GameInstallSource | undefined;
  version?: string | undefined;
  dataDir?: string | undefined;
  pid?: number | undefined;
}

export interface LaunchGameStudioOptions {
  dir?: string | undefined;
  port?: number | undefined;
  dataDir?: string | undefined;
  openBrowser?: boolean | undefined;
  copyToClipboard?: boolean | undefined;
  startupTimeoutMs?: number | undefined;
  opener?: ((url: string) => Promise<OpenBrowserResult> | OpenBrowserResult) | undefined;
}

export interface LaunchGameStudioResult {
  url: string;
  origin: string;
  port: number;
  dir: string;
  source: GameInstallSource;
  version?: string | undefined;
  dataDir: string;
  reused: boolean;
  openedBrowser: boolean;
  browserHint?: string | undefined;
  copiedToClipboard: boolean;
}

interface ActiveGameProcess {
  child: ChildProcess;
  coreBridge?: CausyneCoreBridgeHandle | undefined;
  url: string;
  origin: string;
  port: number;
  dir: string;
  source: GameInstallSource;
  version?: string | undefined;
  dataDir: string;
}

let activeGame: ActiveGameProcess | null = null;
let exitHookInstalled = false;

function causyneCliBinPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'bin', 'causyne.js');
}

function isProcessAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null && !child.killed;
}

function ensureExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    cleanupGameStudioSync();
  });
}

export function cleanupGameStudioSync(): void {
  const current = activeGame;
  activeGame = null;
  if (!current) return;
  try {
    if (isProcessAlive(current.child)) current.child.kill('SIGTERM');
  } catch {
    // Best-effort cleanup on process exit.
  }
}

export function getGameStudioStatus(): ActiveGameStudioStatus {
  if (!activeGame || !isProcessAlive(activeGame.child)) {
    activeGame = null;
    return { running: false };
  }
  return {
    running: true,
    url: activeGame.url,
    origin: activeGame.origin,
    port: activeGame.port,
    dir: activeGame.dir,
    source: activeGame.source,
    ...(activeGame.version ? { version: activeGame.version } : {}),
    dataDir: activeGame.dataDir,
    ...(typeof activeGame.child.pid === 'number' ? { pid: activeGame.child.pid } : {})
  };
}

export async function stopGameStudio(): Promise<boolean> {
  const current = activeGame;
  activeGame = null;
  if (!current) return false;
  try {
    if (isProcessAlive(current.child)) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(forceTimer);
          resolve();
        };
        const forceTimer = setTimeout(() => {
          try {
            if (isProcessAlive(current.child)) current.child.kill('SIGKILL');
          } catch {
            // Ignore already-exited child.
          }
          done();
        }, 2500);
        if (typeof forceTimer.unref === 'function') forceTimer.unref();
        current.child.once('exit', done);
        try {
          current.child.kill('SIGTERM');
        } catch {
          done();
        }
      });
    }
  } finally {
    await current.coreBridge?.close().catch(() => {});
  }
  return true;
}

async function allocateLoopbackPort(preferredPort: number): Promise<number> {
  const tryBind = (port: number): Promise<number | null> =>
    new Promise((resolve) => {
      const server = net.createServer();
      server.unref();
      server.once('error', () => {
        resolve(null);
      });
      server.listen(port, '127.0.0.1', () => {
        const address = server.address();
        const bound = address && typeof address === 'object' ? address.port : null;
        server.close(() => resolve(bound));
      });
    });

  if (preferredPort > 0) {
    const bound = await tryBind(preferredPort);
    if (bound !== null) return bound;
    throw new Error(`Port ${preferredPort} is already in use on 127.0.0.1.`);
  }

  for (let candidate = 4173; candidate < 4183; candidate++) {
    const bound = await tryBind(candidate);
    if (bound !== null) return bound;
  }
  const ephemeral = await tryBind(0);
  if (ephemeral !== null) return ephemeral;
  throw new Error('Could not allocate a free loopback port on 127.0.0.1.');
}

async function waitForHealth(
  origin: string,
  child: ChildProcess,
  getStderr: () => string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(child)) {
      const detail = getStderr().trim().split('\n').filter(Boolean).slice(-4).join(' | ');
      throw new Error(detail ? `Causyne Game exited during startup: ${detail}` : 'Causyne Game server exited during startup.');
    }
    try {
      const res = await fetch(`${origin}/api/health`, {
        signal: AbortSignal.timeout(1500)
      });
      if (res.ok) return;
    } catch {
      // Server still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Causyne Game did not become ready at ${origin}/api/health within ${Math.round(timeoutMs / 1000)}s.`);
}

function assertRunnableInstallation(located: LocatedGameStudio | null, explicitDir?: string): LocatedGameStudio {
  if (!located) {
    const hint = explicitDir
      ? `No Causyne Game installation found at "${explicitDir}" (missing server.ts or package.json).`
      : `Causyne Game is not installed yet. Run "causyne game install --yes" (or "/game install --yes") to download it from ${defaultGameManifestUrl()}, or set CAUSYNE_GAME_DIR.`;
    throw new Error(hint);
  }
  if (!located.hasNodeModules) {
    throw new Error(`Causyne Game at "${located.dir}" is missing dependencies. Run "npm ci" inside "${located.dir}".`);
  }
  if (!located.hasStudioBuild) {
    throw new Error(`Causyne Game at "${located.dir}" has not been built yet. Run "npm run build:studio" inside "${located.dir}".`);
  }
  return located;
}

export async function launchGameStudio(options: LaunchGameStudioOptions = {}): Promise<LaunchGameStudioResult> {
  const located = assertRunnableInstallation(locateGameStudio(options.dir), options.dir);
  const targetDataDir = options.dataDir ? path.resolve(options.dataDir) : gameDataDir();
  const requestedPort = typeof options.port === 'number' && Number.isInteger(options.port) && options.port >= 0 && options.port <= 65535
    ? options.port
    : 0;
  const openFn = options.opener ?? ((url: string) => openBrowserUrl(url, { noOpen: options.openBrowser === false }));

  let reused = false;
  if (activeGame && isProcessAlive(activeGame.child)) {
    const sameDir = path.resolve(activeGame.dir) === path.resolve(located.dir);
    const samePort = requestedPort === 0 || activeGame.port === requestedPort;
    if (sameDir && samePort) {
      reused = true;
    } else {
      await stopGameStudio();
    }
  } else {
    activeGame = null;
  }

  if (!activeGame) {
    fsSync.mkdirSync(targetDataDir, { recursive: true, mode: 0o700 });
    const port = await allocateLoopbackPort(requestedPort);
    const origin = `http://127.0.0.1:${port}`;
    const url = `${origin}/`;
    const cliBin = causyneCliBinPath();
    const coreBridge = await startCausyneCoreBridge();

    let child: ChildProcess;
    try {
      child = spawn(process.execPath, ['--experimental-strip-types', located.serverEntry], {
        cwd: located.dir,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          HOST: '127.0.0.1',
          MOTION_BIND_HOST: '127.0.0.1',
          MOTION_SHARED_EDITOR: '0',
          PORT: String(port),
          CAUSYNE_GAME_DATA_DIR: targetDataDir,
          MOTION_DATA_DIR: targetDataDir,
          CAUSYNE_BIN: cliBin,
          CAUSYNE_CORE_URL: coreBridge.url,
          CAUSYNE_CORE_TOKEN: coreBridge.token,
          MOTION_PARENT_PID: String(process.pid),
          MOTION_HEADLESS: '1'
        }
      });
    } catch (spawnErr) {
      await coreBridge.close().catch(() => {});
      throw spawnErr;
    }

    let stderrBuf = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrBuf = (stderrBuf + chunk).slice(-4096);
    });
    child.stdout?.resume();

    ensureExitHook();
    const record: ActiveGameProcess = {
      child,
      coreBridge,
      url,
      origin,
      port,
      dir: located.dir,
      source: located.source,
      ...(located.version ? { version: located.version } : {}),
      dataDir: targetDataDir
    };
    activeGame = record;
    child.once('exit', () => {
      if (activeGame === record) {
        activeGame = null;
        void record.coreBridge?.close().catch(() => {});
      }
    });

    try {
      await waitForHealth(origin, child, () => stderrBuf, options.startupTimeoutMs ?? 25_000);
    } catch (error) {
      await stopGameStudio();
      throw error;
    }
  }

  const running = activeGame!;
  const openResult = options.openBrowser === false
    ? { opened: false as const, reason: 'disabled' as const }
    : await Promise.resolve(openFn(running.url));

  let copiedToClipboard = false;
  if (options.copyToClipboard !== false && process.env.CI !== 'true' && process.env.CI !== '1' && process.env.NODE_ENV !== 'test') {
    try {
      copiedToClipboard = Boolean(writeClipboardSync(running.url));
    } catch {
      copiedToClipboard = false;
    }
  }

  return {
    url: running.url,
    origin: running.origin,
    port: running.port,
    dir: running.dir,
    source: running.source,
    ...(running.version ? { version: running.version } : {}),
    dataDir: running.dataDir,
    reused,
    openedBrowser: openResult.opened,
    browserHint: openResult.hint,
    copiedToClipboard
  };
}
