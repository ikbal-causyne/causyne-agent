/**
 * Causyne Agent — Language Server Registry & Zero-Shell Discovery (Phase B1)
 *
 * Discovers already-installed Language Servers on the host PATH without
 * spawning a shell or downloading third-party binaries automatically.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface LspServerSpec {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly extensions: readonly string[];
  readonly rootMarkers: readonly string[];
  readonly installHint: string;
}

export interface DetectedLspServer {
  spec: LspServerSpec;
  available: boolean;
  executablePath: string | null;
}

export interface ResolvedLspServer {
  spec: LspServerSpec;
  executablePath: string;
  languageId: string;
}

const EXTENSION_TO_LANGUAGE_ID: Readonly<Record<string, string>> = Object.freeze({
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.lua': 'lua',
  '.zig': 'zig',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.vue': 'vue',
  '.svelte': 'svelte'
});

export const BUILTIN_LSP_SERVERS: readonly LspServerSpec[] = Object.freeze([
  {
    id: 'typescript',
    label: 'TypeScript / JavaScript Language Server',
    command: 'typescript-language-server',
    args: ['--stdio'],
    extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
    rootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    installHint: 'npm install -g typescript-language-server typescript'
  },
  {
    id: 'basedpyright',
    label: 'Basedpyright (Python)',
    command: 'basedpyright-langserver',
    args: ['--stdio'],
    extensions: ['.py', '.pyi'],
    rootMarkers: ['pyproject.toml', 'pyrightconfig.json', 'setup.py', 'requirements.txt'],
    installHint: 'pip install basedpyright'
  },
  {
    id: 'pyright',
    label: 'Pyright (Python)',
    command: 'pyright-langserver',
    args: ['--stdio'],
    extensions: ['.py', '.pyi'],
    rootMarkers: ['pyproject.toml', 'pyrightconfig.json', 'setup.py', 'requirements.txt'],
    installHint: 'npm install -g pyright'
  },
  {
    id: 'pylsp',
    label: 'Python LSP Server',
    command: 'pylsp',
    args: [],
    extensions: ['.py', '.pyi'],
    rootMarkers: ['pyproject.toml', 'setup.py', 'requirements.txt'],
    installHint: 'pip install python-lsp-server'
  },
  {
    id: 'gopls',
    label: 'gopls (Go)',
    command: 'gopls',
    args: ['serve'],
    extensions: ['.go'],
    rootMarkers: ['go.mod', 'go.work'],
    installHint: 'go install golang.org/x/tools/gopls@latest'
  },
  {
    id: 'rust-analyzer',
    label: 'rust-analyzer (Rust)',
    command: 'rust-analyzer',
    args: [],
    extensions: ['.rs'],
    rootMarkers: ['Cargo.toml'],
    installHint: 'rustup component add rust-analyzer'
  },
  {
    id: 'clangd',
    label: 'clangd (C / C++)',
    command: 'clangd',
    args: [],
    extensions: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh'],
    rootMarkers: ['compile_commands.json', 'CMakeLists.txt', 'Makefile'],
    installHint: 'Install clangd via Xcode Command Line Tools, Homebrew, or apt'
  },
  {
    id: 'zls',
    label: 'zls (Zig)',
    command: 'zls',
    args: [],
    extensions: ['.zig'],
    rootMarkers: ['build.zig'],
    installHint: 'Install zls matching your Zig toolchain version'
  },
  {
    id: 'lua-ls',
    label: 'Lua Language Server',
    command: 'lua-language-server',
    args: [],
    extensions: ['.lua'],
    rootMarkers: ['.luarc.json', '.luarc.jsonc'],
    installHint: 'Install lua-language-server via Homebrew or GitHub releases'
  },
  {
    id: 'jdtls',
    label: 'Eclipse JDT.LS (Java)',
    command: 'jdtls',
    args: [],
    extensions: ['.java'],
    rootMarkers: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle'],
    installHint: 'Install jdtls via Homebrew or Eclipse JDT Language Server'
  },
  {
    id: 'kotlin-ls',
    label: 'Kotlin Language Server',
    command: 'kotlin-language-server',
    args: [],
    extensions: ['.kt', '.kts'],
    rootMarkers: ['build.gradle.kts', 'build.gradle', 'settings.gradle.kts', 'pom.xml'],
    installHint: 'Install kotlin-language-server via Homebrew or GitHub releases'
  },
  {
    id: 'csharp-ls',
    label: 'csharp-ls (C# / .NET)',
    command: 'csharp-ls',
    args: [],
    extensions: ['.cs'],
    rootMarkers: ['global.json', 'Directory.Build.props'],
    installHint: 'dotnet tool install --global csharp-ls'
  },
  {
    id: 'solargraph',
    label: 'Solargraph (Ruby)',
    command: 'solargraph',
    args: ['stdio'],
    extensions: ['.rb'],
    rootMarkers: ['Gemfile', '.rubocop.yml'],
    installHint: 'gem install solargraph'
  },
  {
    id: 'intelephense',
    label: 'Intelephense (PHP)',
    command: 'intelephense',
    args: ['--stdio'],
    extensions: ['.php'],
    rootMarkers: ['composer.json'],
    installHint: 'npm install -g intelephense'
  },
  {
    id: 'sourcekit-lsp',
    label: 'SourceKit-LSP (Swift)',
    command: 'sourcekit-lsp',
    args: [],
    extensions: ['.swift'],
    rootMarkers: ['Package.swift'],
    installHint: 'Install Xcode Command Line Tools or Swift toolchain'
  },
  {
    id: 'vue-ls',
    label: 'Vue Language Server (Volar)',
    command: 'vue-language-server',
    args: ['--stdio'],
    extensions: ['.vue'],
    rootMarkers: ['tsconfig.json', 'vite.config.ts', 'package.json'],
    installHint: 'npm install -g @vue/language-server'
  },
  {
    id: 'svelte-ls',
    label: 'Svelte Language Server',
    command: 'svelteserver',
    args: ['--stdio'],
    extensions: ['.svelte'],
    rootMarkers: ['svelte.config.js', 'svelte.config.ts', 'package.json'],
    installHint: 'npm install -g svelte-language-server'
  }
]);

export function languageIdForFile(filePath: string): string {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return EXTENSION_TO_LANGUAGE_ID[ext] ?? 'plaintext';
}

export function findExecutableOnPath(
  binaryName: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | null {
  if (
    typeof binaryName !== 'string'
    || binaryName.length === 0
    || binaryName.length > 128
    || binaryName.includes('\0')
    || binaryName.includes('/')
    || binaryName.includes('\\')
    || binaryName.includes('..')
  ) {
    return null;
  }

  const rawPath = env.PATH || env.Path || '';
  if (!rawPath) return null;

  const isWin = platform === 'win32';
  const delimiter = isWin ? ';' : ':';
  const extensions = isWin
    ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.trim()).filter(Boolean)
    : [''];

  for (const rawDir of rawPath.split(delimiter)) {
    let dir = rawDir.trim();
    if (dir.length >= 2 && dir.startsWith('"') && dir.endsWith('"')) {
      dir = dir.slice(1, -1);
    }
    if (!dir || dir.includes('\0') || !path.isAbsolute(dir)) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, ext && !binaryName.toLowerCase().endsWith(ext.toLowerCase()) ? `${binaryName}${ext}` : binaryName);
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) continue;
        if (!isWin) {
          fs.accessSync(candidate, fs.constants.X_OK);
        }
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return null;
}

const MAX_CUSTOM_LSP_CONFIG_BYTES = 64 * 1024;

/**
 * Loads optional workspace-scoped LSP overrides from `.causyne/lsp.json`.
 * Rejects symlinks, invalid executables, and NUL/control characters cleanly.
 */
export function loadCustomLspServers(workspaceRoot?: string): LspServerSpec[] {
  if (!workspaceRoot || typeof workspaceRoot !== 'string' || workspaceRoot.includes('\0')) return [];
  const cfgPath = path.join(path.resolve(workspaceRoot), '.causyne', 'lsp.json');
  try {
    const stat = fs.lstatSync(cfgPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_CUSTOM_LSP_CONFIG_BYTES) return [];
    const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { servers?: unknown };
    const rawList = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.servers) ? parsed.servers : []);
    const specs: LspServerSpec[] = [];
    for (const entry of rawList.slice(0, 32)) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const id = typeof rec.id === 'string' ? rec.id.trim() : '';
      const command = typeof rec.command === 'string' ? rec.command.trim() : '';
      const extensions = Array.isArray(rec.extensions)
        ? rec.extensions.filter((e): e is string => typeof e === 'string' && e.startsWith('.') && e.length <= 16).map((e) => e.toLowerCase())
        : [];
      if (!id || !command || command.includes('\0') || /[\r\n]/.test(command) || extensions.length === 0) continue;
      const args = Array.isArray(rec.args)
        ? rec.args.filter((a): a is string => typeof a === 'string' && !a.includes('\0'))
        : [];
      const rootMarkers = Array.isArray(rec.rootMarkers)
        ? rec.rootMarkers.filter((m): m is string => typeof m === 'string' && m.trim().length > 0 && !m.includes('\0'))
        : [];
      specs.push({
        id,
        label: typeof rec.label === 'string' && rec.label.trim() ? rec.label.trim() : id,
        command,
        args,
        extensions,
        rootMarkers,
        installHint: typeof rec.installHint === 'string' ? rec.installHint.trim() : `Install ${command}`
      });
    }
    return specs;
  } catch {
    return [];
  }
}

/**
 * Checks workspace-local `.venv`, `venv`, `node_modules/.bin`, user toolchain dirs
 * (`~/go/bin`, `~/.cargo/bin`, `~/.local/bin`), and host PATH without invoking a shell.
 */
export function findLocalOrPathExecutable(
  binaryName: string,
  workspaceRoot?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | null {
  if (typeof binaryName !== 'string' || !binaryName.trim() || binaryName.includes('\0')) return null;
  const trimmed = binaryName.trim();
  const isWin = platform === 'win32';
  const checkCandidateFile = (candidate: string): string | null => {
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) return null;
      if (!isWin) fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      return null;
    }
  };

  if (path.isAbsolute(trimmed)) {
    return checkCandidateFile(trimmed);
  }

  const probeDirs: string[] = [];
  if (workspaceRoot && typeof workspaceRoot === 'string' && !workspaceRoot.includes('\0')) {
    const resolvedWs = path.resolve(workspaceRoot);
    const venvSub = isWin ? 'Scripts' : 'bin';
    probeDirs.push(
      path.join(resolvedWs, 'node_modules', '.bin'),
      path.join(resolvedWs, '.venv', venvSub),
      path.join(resolvedWs, 'venv', venvSub)
    );
  }
  const home = env === process.env
    ? (env.HOME || env.USERPROFILE || os.homedir())
    : (env.HOME || env.USERPROFILE || '');
  if (home && path.isAbsolute(home)) {
    probeDirs.push(
      path.join(home, '.local', 'bin'),
      path.join(home, 'go', 'bin'),
      path.join(home, '.cargo', 'bin')
    );
  }

  const exts = isWin ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of probeDirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, ext && !trimmed.toLowerCase().endsWith(ext) ? `${trimmed}${ext}` : trimmed);
      const hit = checkCandidateFile(candidate);
      if (hit) return hit;
    }
  }
  return findExecutableOnPath(trimmed, env, platform);
}

export function detectInstalledLspServers(
  workspaceRoot?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): DetectedLspServer[] {
  const custom = loadCustomLspServers(workspaceRoot);
  const seenIds = new Set(custom.map((s) => s.id));
  const combined = [...custom, ...BUILTIN_LSP_SERVERS.filter((s) => !seenIds.has(s.id))];
  return combined.map((spec) => {
    const executablePath = findLocalOrPathExecutable(spec.command, workspaceRoot, env, platform);
    return {
      spec,
      available: executablePath !== null,
      executablePath
    };
  });
}

export function matchingSpecsForFile(filePath: string, workspaceRoot?: string): LspServerSpec[] {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (!ext) return [];
  const custom = loadCustomLspServers(workspaceRoot);
  const seenIds = new Set(custom.map((s) => s.id));
  const combined = [...custom, ...BUILTIN_LSP_SERVERS.filter((s) => !seenIds.has(s.id))];
  return combined.filter((spec) => spec.extensions.includes(ext));
}

export function resolveLspServerForFile(
  filePath: string,
  workspaceRoot?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): ResolvedLspServer | null {
  const specs = matchingSpecsForFile(filePath, workspaceRoot);
  const languageId = languageIdForFile(filePath);
  for (const spec of specs) {
    const executablePath = findLocalOrPathExecutable(spec.command, workspaceRoot, env, platform);
    if (executablePath) {
      return { spec, executablePath, languageId };
    }
  }
  return null;
}

export function findWorkspaceRootForLsp(
  filePath: string,
  spec: LspServerSpec,
  boundaryRoot: string
): string {
  const resolvedBoundary = path.resolve(boundaryRoot);
  let current = path.dirname(path.resolve(filePath));
  for (let depth = 0; depth < 32; depth++) {
    const rel = path.relative(resolvedBoundary, current);
    const withinBoundary = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    if (!withinBoundary) break;
    for (const marker of spec.rootMarkers) {
      try {
        if (fs.existsSync(path.join(current, marker))) {
          return current;
        }
      } catch {
        continue;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolvedBoundary;
}
