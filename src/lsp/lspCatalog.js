/**
 * Causyne Agent — Language Server Registry & Zero-Shell Discovery (Phase B1)
 *
 * Discovers already-installed Language Servers on the host PATH without
 * spawning a shell or downloading third-party binaries automatically.
 */
import fs from 'node:fs';
import path from 'node:path';
const EXTENSION_TO_LANGUAGE_ID = Object.freeze({
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
    '.zig': 'zig'
});
export const BUILTIN_LSP_SERVERS = Object.freeze([
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
    }
]);
export function languageIdForFile(filePath) {
    const ext = path.extname(String(filePath || '')).toLowerCase();
    return EXTENSION_TO_LANGUAGE_ID[ext] ?? 'plaintext';
}
export function findExecutableOnPath(binaryName, env = process.env, platform = process.platform) {
    if (typeof binaryName !== 'string'
        || binaryName.length === 0
        || binaryName.length > 128
        || binaryName.includes('\0')
        || binaryName.includes('/')
        || binaryName.includes('\\')
        || binaryName.includes('..')) {
        return null;
    }
    const rawPath = env.PATH || env.Path || '';
    if (!rawPath)
        return null;
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
        if (!dir || dir.includes('\0') || !path.isAbsolute(dir))
            continue;
        for (const ext of extensions) {
            const candidate = path.join(dir, ext && !binaryName.toLowerCase().endsWith(ext.toLowerCase()) ? `${binaryName}${ext}` : binaryName);
            try {
                const stat = fs.statSync(candidate);
                if (!stat.isFile())
                    continue;
                if (!isWin) {
                    fs.accessSync(candidate, fs.constants.X_OK);
                }
                return candidate;
            }
            catch {
                continue;
            }
        }
    }
    return null;
}
/**
 * Also checks workspace-local `node_modules/.bin/<command>` when inside a Node project.
 */
export function findLocalOrPathExecutable(binaryName, workspaceRoot, env = process.env, platform = process.platform) {
    if (workspaceRoot && typeof workspaceRoot === 'string' && !workspaceRoot.includes('\0')) {
        const binDir = path.join(path.resolve(workspaceRoot), 'node_modules', '.bin');
        const isWin = platform === 'win32';
        const candidates = isWin
            ? [path.join(binDir, `${binaryName}.cmd`), path.join(binDir, `${binaryName}.exe`), path.join(binDir, binaryName)]
            : [path.join(binDir, binaryName)];
        for (const candidate of candidates) {
            try {
                const stat = fs.statSync(candidate);
                if (!stat.isFile())
                    continue;
                if (!isWin)
                    fs.accessSync(candidate, fs.constants.X_OK);
                return candidate;
            }
            catch {
                continue;
            }
        }
    }
    return findExecutableOnPath(binaryName, env, platform);
}
export function detectInstalledLspServers(workspaceRoot, env = process.env, platform = process.platform) {
    return BUILTIN_LSP_SERVERS.map((spec) => {
        const executablePath = findLocalOrPathExecutable(spec.command, workspaceRoot, env, platform);
        return {
            spec,
            available: executablePath !== null,
            executablePath
        };
    });
}
export function matchingSpecsForFile(filePath) {
    const ext = path.extname(String(filePath || '')).toLowerCase();
    if (!ext)
        return [];
    return BUILTIN_LSP_SERVERS.filter((spec) => spec.extensions.includes(ext));
}
export function resolveLspServerForFile(filePath, workspaceRoot, env = process.env, platform = process.platform) {
    const specs = matchingSpecsForFile(filePath);
    const languageId = languageIdForFile(filePath);
    for (const spec of specs) {
        const executablePath = findLocalOrPathExecutable(spec.command, workspaceRoot, env, platform);
        if (executablePath) {
            return { spec, executablePath, languageId };
        }
    }
    return null;
}
export function findWorkspaceRootForLsp(filePath, spec, boundaryRoot) {
    const resolvedBoundary = path.resolve(boundaryRoot);
    let current = path.dirname(path.resolve(filePath));
    for (let depth = 0; depth < 32; depth++) {
        const rel = path.relative(resolvedBoundary, current);
        const withinBoundary = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
        if (!withinBoundary)
            break;
        for (const marker of spec.rootMarkers) {
            try {
                if (fs.existsSync(path.join(current, marker))) {
                    return current;
                }
            }
            catch {
                continue;
            }
        }
        const parent = path.dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    return resolvedBoundary;
}
