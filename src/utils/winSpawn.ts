import fs from 'node:fs';
import path from 'node:path';

export interface WindowsSpawnResolution {
  command: string;
  args: string[];
  resolvedFromShim: boolean;
}

export interface ResolveWindowsSpawnOptions {
  platform?: NodeJS.Platform | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  execPath?: string | undefined;
}

const CMD_SHIM_EXT_RE = /\.(?:cmd|bat)$/i;
const NPM_SHIM_NAME_RE = /^(?:npm|npx)(?:\.cmd)?$/i;
const MAX_SHIM_BYTES = 16 * 1024;

function isExistingRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Reconcile case-insensitive `PATH` / `Path` keys in a shallow-copied Windows
 * environment object so prepended directories are never shadowed by a stale
 * duplicate `Path` entry.
 */
export function reconcileWindowsPathEnv(
  env: NodeJS.ProcessEnv,
  prependDirs: readonly string[] = [],
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  const delimiter = platform === 'win32' ? ';' : ':';
  let currentPath = '';
  let primaryKey = 'PATH';

  if (platform === 'win32') {
    for (const key of Object.keys(next)) {
      if (key.toLowerCase() === 'path') {
        const val = next[key];
        if (!currentPath && typeof val === 'string' && val.length > 0) {
          currentPath = val;
          primaryKey = key;
        }
        delete next[key];
      }
    }
  } else {
    currentPath = next.PATH || '';
  }

  const cleanedPrepends = prependDirs.filter((dir) => typeof dir === 'string' && dir.length > 0);
  const merged = [...cleanedPrepends, currentPath].filter(Boolean).join(delimiter);
  next[platform === 'win32' ? 'PATH' : primaryKey] = merged;
  return next;
}

/**
 * Look up a bare executable name on PATH using PATHEXT on Windows.
 */
export function resolveCommandOnWindowsPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (!command || command.includes('\0')) return null;

  const hasSep = command.includes('/') || command.includes('\\');
  const rawExts = (env.PATHEXT || env.PathExt || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.trim())
    .filter((ext) => ext.startsWith('.'));
  const hasKnownExt = /\.[A-Za-z0-9]{1,8}$/.test(command);

  if (hasSep) {
    if (isExistingRegularFile(command)) return command;
    if (!hasKnownExt) {
      for (const ext of rawExts) {
        const candidate = `${command}${ext}`;
        if (isExistingRegularFile(candidate)) return candidate;
      }
    }
    return null;
  }

  let rawPath = '';
  for (const [k, v] of Object.entries(env)) {
    if (k.toLowerCase() === 'path' && typeof v === 'string' && v.length > 0) {
      rawPath = v;
      break;
    }
  }
  if (!rawPath) return null;

  const dirs = rawPath.split(';').map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean);
  for (const dir of dirs) {
    if (hasKnownExt) {
      const exact = path.join(dir, command);
      if (isExistingRegularFile(exact)) return exact;
    } else {
      for (const ext of rawExts) {
        const candidate = path.join(dir, `${command}${ext}`);
        if (isExistingRegularFile(candidate)) return candidate;
      }
      const exact = path.join(dir, command);
      if (isExistingRegularFile(exact)) return exact;
    }
  }
  return null;
}

/**
 * Locate Node's bundled `npm-cli.js` or `npx-cli.js` so Windows never has to
 * invoke `npm.cmd` via `cmd.exe` (avoiding Node 24+ `.cmd` EINVAL errors and
 * shell quoting hazards).
 */
export function resolveNpmCliScript(
  command: string,
  execPath: string = process.execPath
): string | null {
  const base = path.basename(command).toLowerCase();
  if (!NPM_SHIM_NAME_RE.test(base)) return null;
  const cliFile = base.startsWith('npx') ? 'npx-cli.js' : 'npm-cli.js';

  const candidateDirs: string[] = [];
  if (command.includes('/') || command.includes('\\')) {
    candidateDirs.push(path.dirname(command));
  }
  if (execPath) {
    candidateDirs.push(path.dirname(execPath));
  }

  for (const dir of candidateDirs) {
    const direct = path.join(dir, 'node_modules', 'npm', 'bin', cliFile);
    if (isExistingRegularFile(direct)) return direct;
    const sibling = path.join(dir, '..', 'node_modules', 'npm', 'bin', cliFile);
    if (isExistingRegularFile(sibling)) return sibling;
  }
  return null;
}

/**
 * Unwrap standard npm/pnpm/yarn generated `.cmd` shims (`"%dp0%\...\cli.js"`)
 * directly to their underlying Node entry script so they execute via `node`
 * with `shell: false`.
 */
export function unwrapNodeCmdShim(shimPath: string): string | null {
  if (!CMD_SHIM_EXT_RE.test(shimPath) || !isExistingRegularFile(shimPath)) return null;
  let content: string;
  try {
    const stat = fs.statSync(shimPath);
    if (stat.size > MAX_SHIM_BYTES) return null;
    content = fs.readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }

  const shimDir = path.dirname(shimPath);
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('@echo') || line.startsWith('REM ') || line.startsWith('::')) continue;
    const markerIdx = line.indexOf('%dp0%\\') >= 0
      ? line.indexOf('%dp0%\\')
      : line.indexOf('%~dp0\\');
    if (markerIdx < 0) continue;
    const prefixLen = line.startsWith('%~dp0\\', markerIdx) ? 6 : 6;
    const rest = line.slice(markerIdx + prefixLen);
    let endIdx = -1;
    for (let i = 0; i < rest.length; i++) {
      const ch = rest[i];
      if (ch === '"' || ch === '\r' || ch === '\n') {
        endIdx = i;
        break;
      }
    }
    const relRaw = (endIdx >= 0 ? rest.slice(0, endIdx) : rest.split(/\s+/)[0] || '').trim();
    if (!relRaw || !/\.(?:c|m)?js$/i.test(relRaw)) continue;
    if (/[<>|&^%!\0]/.test(relRaw)) continue;
    const candidate = path.resolve(shimDir, relRaw.replace(/\\/g, path.sep));
    if (isExistingRegularFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Escape a single argument for safe `cmd.exe /d /s /c` invocation when a
 * non-Node `.cmd`/`.bat` batch file must be executed on Windows.
 */
export function quoteWindowsCmdArg(arg: string): string {
  if (arg.includes('\0') || arg.includes('\r') || arg.includes('\n')) {
    throw new Error('Refusing Windows batch argument containing NUL or newline characters.');
  }
  if (arg.length === 0) return '""';

  // Build quoted Windows command-line argument in strict O(n) linear time (zero ReDoS).
  const needsQuotes = /[\s"]/.test(arg);
  if (needsQuotes) {
    let out = '"';
    let pendingBackslashes = 0;
    for (let i = 0; i < arg.length; i++) {
      const ch = arg[i]!;
      if (ch === '\\') {
        pendingBackslashes++;
      } else if (ch === '"') {
        out += '\\'.repeat(pendingBackslashes * 2) + '\\"';
        pendingBackslashes = 0;
      } else if (ch === '%') {
        out += '\\'.repeat(pendingBackslashes) + '%%';
        pendingBackslashes = 0;
      } else {
        out += '\\'.repeat(pendingBackslashes) + ch;
        pendingBackslashes = 0;
      }
    }
    out += '\\'.repeat(pendingBackslashes * 2) + '"';
    return out;
  }

  let out = '';
  const metaChars = new Set(['(', ')', '%', '!', '^', '"', '<', '>', '&', '|']);
  for (let i = 0; i < arg.length; i++) {
    const ch = arg[i]!;
    out += metaChars.has(ch) ? `^${ch}` : ch;
  }
  return out;
}

/**
 * Resolve a `(command, args)` pair so Windows Node 24+ `spawn(..., { shell: false })`
 * never throws `EINVAL` on `.cmd`/`.bat` shims while preserving `shell: false`
 * and strict argument safety.
 */
export function resolveWindowsSpawnTarget(
  command: string,
  args: readonly string[],
  options: ResolveWindowsSpawnOptions = {}
): WindowsSpawnResolution {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    return { command, args: [...args], resolvedFromShim: false };
  }

  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;

  // 1. Direct Node invocation for npm / npx without going through cmd.exe
  const npmCli = resolveNpmCliScript(command, execPath);
  if (npmCli) {
    return { command: execPath, args: [npmCli, ...args], resolvedFromShim: true };
  }

  // 2. Locate `.cmd` shim on PATH/PATHEXT when needed so it can be unwrapped to `node <entry.js>`
  const shimCandidate = CMD_SHIM_EXT_RE.test(command)
    ? command
    : resolveCommandOnWindowsPath(command, env);

  if (shimCandidate && CMD_SHIM_EXT_RE.test(shimCandidate)) {
    // 3. Unwrap npm/yarn/pnpm `.cmd` shims straight to `node <entry.js>` (zero cmd.exe shell)
    const unwrapped = unwrapNodeCmdShim(shimCandidate);
    if (unwrapped) {
      return { command: execPath, args: [unwrapped, ...args], resolvedFromShim: true };
    }
    throw new Error(
      `Refusing to execute non-Node Windows batch script (${path.basename(shimCandidate)}) via cmd.exe shell.`
    );
  }

  return { command, args: [...args], resolvedFromShim: false };
}
