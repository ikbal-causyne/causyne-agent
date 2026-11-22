/**
 * Causyne Agent — PageRank-Ranked Repository Architectural Map (Phase C-Core)
 *
 * Builds a compact, token-budgeted architectural outline of any codebase:
 *   1. Safely walks workspace source files (respects HEAVY_DEV_EXCLUDES, skips
 *      symlinks, binaries, and oversized files).
 *   2. Extracts declarations (`class`, `interface`, `type`, `function`, `const`,
 *      `def`, `struct`, `enum`, `trait`, `impl`, `func`) and import edges across
 *      TypeScript, JavaScript, Python, Go, Rust, and C/C++ with linear scanners.
 *   3. Ranks files by cross-file reference centrality (PageRank) + focus-file
 *      boosts so the most structurally important symbols fit inside `maxChars`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { BINARY_EXTENSIONS_RE, HEAVY_DEV_EXCLUDES } from '../tools/walkerSafety.js';
import { safeDisplay } from '../tui/text.js';

export interface RepoMapSymbol {
  kind: string;
  name: string;
  line: number;
  exported: boolean;
}

export interface RepoMapFileNode {
  relPath: string;
  absPath: string;
  language: string;
  symbols: RepoMapSymbol[];
  imports: string[];
  rank: number;
}

export interface RepoMapResult {
  workspaceRoot: string;
  totalSourceFiles: number;
  mappedFiles: number;
  truncated: boolean;
  files: RepoMapFileNode[];
  rendered: string;
}

export interface RepoMapOptions {
  maxFiles?: number | undefined;
  maxChars?: number | undefined;
  focusFiles?: readonly string[] | undefined;
}

const SOURCE_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts',
  '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js',
  '.py': 'py', '.go': 'go', '.rs': 'rs',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp',
  '.java': 'java', '.kt': 'kt', '.swift': 'swift', '.zig': 'zig'
});

const MAX_SCAN_FILES = 1500;
const MAX_SINGLE_FILE_BYTES = 256 * 1024;
const MAX_SYMBOLS_PER_FILE = 40;
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,80}$/;

function extractJsTsSymbolsAndImports(lines: readonly string[]): { symbols: RepoMapSymbol[]; imports: string[] } {
  const symbols: RepoMapSymbol[] = [];
  const imports: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    // Import target extraction
    if (trimmed.startsWith('import ') || trimmed.startsWith('export ')) {
      const fromIdx = trimmed.indexOf(' from ');
      if (fromIdx !== -1) {
        const tail = trimmed.slice(fromIdx + 6).trim();
        const quote = tail[0];
        if (quote === "'" || quote === '"') {
          const endQuote = tail.indexOf(quote, 1);
          if (endQuote > 1) imports.push(tail.slice(1, endQuote));
        }
      }
    }

    if (symbols.length >= MAX_SYMBOLS_PER_FILE) continue;
    // Only top-level or lightly indented declarations
    const indent = raw.length - raw.trimStart().length;
    if (indent > 2) continue;

    let rest = trimmed;
    let exported = false;
    if (rest.startsWith('export ')) {
      exported = true;
      rest = rest.slice('export '.length).trim();
      if (rest.startsWith('default ')) rest = rest.slice('default '.length).trim();
      if (rest.startsWith('declare ')) rest = rest.slice('declare '.length).trim();
    }
    if (rest.startsWith('async ')) rest = rest.slice('async '.length).trim();
    if (rest.startsWith('abstract ')) rest = rest.slice('abstract '.length).trim();

    const keywords: Array<[string, string]> = [
      ['function ', 'fn'],
      ['class ', 'class'],
      ['interface ', 'interface'],
      ['type ', 'type'],
      ['enum ', 'enum'],
      ['const ', 'const']
    ];
    for (const [prefix, kind] of keywords) {
      if (!rest.startsWith(prefix)) continue;
      if (kind === 'const' && !exported) continue;
      const after = rest.slice(prefix.length).trim();
      let end = 0;
      while (end < after.length && /[A-Za-z0-9_$]/.test(after[end]!)) end++;
      const name = after.slice(0, end);
      if (IDENT_RE.test(name)) {
        symbols.push({ kind, name, line: i + 1, exported });
      }
      break;
    }
  }
  return { symbols, imports };
}

function extractPythonSymbolsAndImports(lines: readonly string[]): { symbols: RepoMapSymbol[]; imports: string[] } {
  const symbols: RepoMapSymbol[] = [];
  const imports: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('from ')) {
      const impIdx = trimmed.indexOf(' import ');
      if (impIdx > 5) imports.push(trimmed.slice(5, impIdx).trim());
      continue;
    }
    if (trimmed.startsWith('import ')) {
      imports.push(trimmed.slice(7).split(',')[0]!.trim().split(/\s+/)[0] || '');
      continue;
    }
    if (symbols.length >= MAX_SYMBOLS_PER_FILE) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent > 4) continue;
    let rest = trimmed;
    if (rest.startsWith('async ')) rest = rest.slice(6).trim();
    const kind = rest.startsWith('class ') ? 'class' : (rest.startsWith('def ') ? 'def' : null);
    if (!kind) continue;
    const after = rest.slice(kind.length + 1).trim();
    let end = 0;
    while (end < after.length && /[A-Za-z0-9_]/.test(after[end]!)) end++;
    const name = after.slice(0, end);
    if (IDENT_RE.test(name)) {
      symbols.push({ kind, name, line: i + 1, exported: !name.startsWith('_') });
    }
  }
  return { symbols, imports: imports.filter(Boolean) };
}

function extractGenericSymbols(lines: readonly string[], lang: string): { symbols: RepoMapSymbol[]; imports: string[] } {
  const symbols: RepoMapSymbol[] = [];
  const imports: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
    if (symbols.length >= MAX_SYMBOLS_PER_FILE) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent > 4) continue;

    let rest = trimmed;
    let exported = false;
    if (lang === 'rs' && rest.startsWith('pub ')) {
      exported = true;
      rest = rest.slice(4).trim();
      if (rest.startsWith('async ')) rest = rest.slice(6).trim();
    }
    const prefixes: Array<[string, string]> = lang === 'go'
      ? [['func ', 'func'], ['type ', 'type']]
      : lang === 'rs'
        ? [['fn ', 'fn'], ['struct ', 'struct'], ['enum ', 'enum'], ['trait ', 'trait'], ['impl ', 'impl']]
        : [['class ', 'class'], ['struct ', 'struct'], ['enum ', 'enum'], ['fn ', 'fn']];

    for (const [prefix, kind] of prefixes) {
      if (!rest.startsWith(prefix)) continue;
      let after = rest.slice(prefix.length).trim();
      if (lang === 'go' && kind === 'func' && after.startsWith('(')) {
        const close = after.indexOf(')');
        if (close !== -1) after = after.slice(close + 1).trim();
      }
      let end = 0;
      while (end < after.length && /[A-Za-z0-9_]/.test(after[end]!)) end++;
      const name = after.slice(0, end);
      if (IDENT_RE.test(name)) {
        const isGoExport = lang === 'go' && name.length > 0 && name[0]! >= 'A' && name[0]! <= 'Z';
        symbols.push({ kind, name, line: i + 1, exported: exported || isGoExport });
      }
      break;
    }
  }
  return { symbols, imports };
}

function resolveImportTarget(fromRelPath: string, importSpec: string, knownFiles: ReadonlySet<string>): string | null {
  if (!importSpec || !importSpec.startsWith('.')) return null;
  const baseDir = path.posix.dirname(fromRelPath);
  const joined = path.posix.normalize(path.posix.join(baseDir, importSpec));
  if (knownFiles.has(joined)) return joined;
  const stem = joined.replace(/\.(js|mjs|cjs|jsx)$/, '');
  const tryExts = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.py', '/index.ts', '/index.js'];
  for (const ext of tryExts) {
    const candidate = `${stem}${ext}`;
    if (knownFiles.has(candidate)) return candidate;
  }
  return null;
}

export function buildRepoMap(workspaceRoot: string, options: RepoMapOptions = {}): RepoMapResult {
  const root = path.resolve(workspaceRoot);
  const maxFiles = Math.max(10, Math.min(MAX_SCAN_FILES, options.maxFiles ?? 400));
  const maxChars = Math.max(400, Math.min(48_000, options.maxChars ?? 6_000));
  const focusSet = new Set(
    (options.focusFiles ?? [])
      .filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
      .map((f) => path.relative(root, path.resolve(root, f.trim())).replace(/\\/g, '/'))
  );

  // Bounded iterative walk (no recursion overflow, no symlink escape)
  const discovered: Array<{ absPath: string; relPath: string; language: string }> = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let totalSourceFiles = 0;

  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth > 12) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (HEAVY_DEV_EXCLUDES.has(entry.name) || entry.name === '.causyne-worktrees' || entry.name.startsWith('.')) {
          continue;
        }
        stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (BINARY_EXTENSIONS_RE.test(entry.name)) continue;
      const ext = path.extname(entry.name).toLowerCase();
      const language = SOURCE_EXTENSIONS[ext];
      if (!language) continue;
      totalSourceFiles++;
      if (discovered.length >= maxFiles) continue;
      const absPath = path.join(dir, entry.name);
      const relPath = path.relative(root, absPath).replace(/\\/g, '/');
      discovered.push({ absPath, relPath, language });
    }
  }

  const knownRelSet = new Set(discovered.map((d) => d.relPath));
  const nodes: RepoMapFileNode[] = [];
  for (const item of discovered) {
    let text = '';
    try {
      const stat = fs.lstatSync(item.absPath);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_SINGLE_FILE_BYTES) continue;
      text = fs.readFileSync(item.absPath, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    const extracted = (item.language === 'ts' || item.language === 'js')
      ? extractJsTsSymbolsAndImports(lines)
      : item.language === 'py'
        ? extractPythonSymbolsAndImports(lines)
        : extractGenericSymbols(lines, item.language);
    nodes.push({
      relPath: item.relPath,
      absPath: item.absPath,
      language: item.language,
      symbols: extracted.symbols,
      imports: extracted.imports,
      rank: 1
    });
  }

  // Build directed dependency graph & run 6-iteration PageRank centrality
  const indexByRel = new Map<string, number>();
  nodes.forEach((n, idx) => indexByRel.set(n.relPath, idx));
  const outgoing: number[][] = nodes.map(() => []);
  const incoming: number[][] = nodes.map(() => []);

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    for (const spec of node.imports) {
      const resolved = resolveImportTarget(node.relPath, spec, knownRelSet);
      if (!resolved) continue;
      const targetIdx = indexByRel.get(resolved);
      if (targetIdx !== undefined && targetIdx !== i) {
        outgoing[i]!.push(targetIdx);
        incoming[targetIdx]!.push(i);
      }
    }
  }

  const n = nodes.length;
  if (n > 0) {
    const damping = 0.85;
    let scores = new Float64Array(n).fill(1 / n);
    for (let iter = 0; iter < 6; iter++) {
      const next = new Float64Array(n);
      const baseTeleport = (1 - damping) / n;
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (const src of incoming[i]!) {
          const deg = outgoing[src]!.length;
          if (deg > 0) sum += scores[src]! / deg;
        }
        const focusBoost = focusSet.has(nodes[i]!.relPath) ? 0.5 : 0;
        const exportBoost = Math.min(0.1, nodes[i]!.symbols.filter((s) => s.exported).length * 0.005);
        next[i] = baseTeleport + damping * sum + focusBoost + exportBoost;
      }
      scores = next;
    }
    for (let i = 0; i < n; i++) {
      nodes[i]!.rank = Number(scores[i]!.toFixed(5));
    }
  }

  nodes.sort((a, b) => b.rank - a.rank || a.relPath.localeCompare(b.relPath));

  // Render token-budgeted architectural outline
  const header = `# Repository Map (${nodes.length}/${totalSourceFiles} source file(s), ranked by dependency centrality)\n`;
  const chunks: string[] = [header];
  let charBudgetUsed = header.length;
  let mappedFiles = 0;
  let truncated = totalSourceFiles > nodes.length;

  for (const node of nodes) {
    const symList = node.symbols.slice(0, 12).map((s) => `${s.kind} ${s.name}:${s.line}`).join(', ');
    const line = symList
      ? `${safeDisplay(node.relPath)}  [rank=${node.rank.toFixed(3)}]\n  ${safeDisplay(symList)}\n`
      : `${safeDisplay(node.relPath)}  [rank=${node.rank.toFixed(3)}]\n`;
    if (charBudgetUsed + line.length > maxChars) {
      truncated = true;
      break;
    }
    chunks.push(line);
    charBudgetUsed += line.length;
    mappedFiles++;
  }

  return {
    workspaceRoot: root,
    totalSourceFiles,
    mappedFiles,
    truncated,
    files: nodes,
    rendered: chunks.join('')
  };
}
