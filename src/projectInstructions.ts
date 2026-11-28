/**
 * Causyne Agent — Hierarchical Project Instructions & Personalization Loader
 *
 * Discovers and merges instruction files in deterministic precedence:
 *   1. User global `~/.causyne/CAUSYNE.md` (and `~/.causyne/AGENTS.md` if distinct)
 *   2. Repository/workspace root down to active subdirectory:
 *      `CAUSYNE.md`, `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`
 *   3. Scoped rule files under `.causyne/rules/*.md` (lexicographical order)
 *   4. Per-project Personalization under `.causyne/personalization.md` (highest project authority)
 *
 * Security invariants:
 *   - Refuses symlinks and non-regular files (`lstatSync`).
 *   - Enforces strict per-file (`16 KiB`) and total (`32 KiB`) character budgets.
 *   - Redacts accidental provider secrets and sanitizes terminal control escapes.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from './utils/paths.js';
import { redactTextSecrets } from './providers/byokHttp.js';
import { safeDisplay } from './tui/text.js';
import { resolveGitRepoRoot } from './worktreeManager.js';
import { createIgnoreMatcher, parseIgnoreContent } from './ignoreRules.js';

export interface ProjectInstructionEntry {
  sourcePath: string;
  scope: 'global' | 'workspace' | 'rule' | 'personalization';
  bytes: number;
  truncated: boolean;
  content: string;
  globs?: string[] | undefined;
}

export interface LoadProjectInstructionsOptions {
  activeFiles?: readonly string[] | undefined;
  includeUnmatchedScoped?: boolean | undefined;
}

export interface LoadedProjectInstructions {
  workspaceRoot: string;
  repoRoot: string | null;
  entries: ProjectInstructionEntry[];
  totalChars: number;
  truncated: boolean;
}

const MAX_SINGLE_INSTRUCTION_CHARS = 16_384;
const MAX_TOTAL_INSTRUCTION_CHARS = 32_768;
const MAX_RULE_FILES = 24;
const MAX_INCLUDE_DEPTH = 3;
const MAX_INCLUDES_PER_FILE = 8;
const INSTRUCTION_FILENAMES = ['CAUSYNE.md', 'AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md'] as const;

function parseRuleFrontmatter(raw: string): { globs: string[]; body: string } {
  const normalized = raw.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { globs: [], body: normalized };
  }
  const endIdx = normalized.indexOf('\n---', 4);
  if (endIdx === -1) return { globs: [], body: normalized };
  const afterEnd = endIdx + 4;
  if (afterEnd < normalized.length && normalized[afterEnd] !== '\n') {
    return { globs: [], body: normalized };
  }
  const header = normalized.slice(4, endIdx);
  const body = normalized.slice(afterEnd + (normalized[afterEnd] === '\n' ? 1 : 0));

  const globs: string[] = [];
  const lines = header.split('\n');
  let inGlobList = false;
  const pushClean = (rawItem: string): void => {
    const cleaned = rawItem.trim().replace(/^['"]|['"]$/g, '').trim();
    if (cleaned && !cleaned.includes('\0') && cleaned.length <= 256) {
      globs.push(cleaned);
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const keyMatch = trimmed.match(/^(paths|globs)\s*:\s*(.*)$/i);
    if (keyMatch) {
      const value = (keyMatch[2] || '').trim();
      if (!value) {
        inGlobList = true;
      } else if (value.startsWith('[') && value.endsWith(']')) {
        inGlobList = false;
        for (const item of value.slice(1, -1).split(',')) pushClean(item);
      } else {
        inGlobList = false;
        for (const item of value.split(',')) pushClean(item);
      }
      continue;
    }
    if (inGlobList) {
      if (trimmed.startsWith('- ')) {
        pushClean(trimmed.slice(2));
      } else if (/^[a-zA-Z0-9_-]+\s*:/.test(trimmed)) {
        inGlobList = false;
      }
    }
  }

  return { globs, body };
}

function isWithinBoundary(boundaryRoot: string, targetPath: string): boolean {
  const rel = path.relative(boundaryRoot, targetPath);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function expandSafeIncludes(
  rawText: string,
  filePath: string,
  boundaryRoot: string | null,
  visited: Set<string>,
  depth: number
): string {
  if (!boundaryRoot || depth >= MAX_INCLUDE_DEPTH) return rawText;
  const baseDir = path.dirname(filePath);
  const lines = rawText.split('\n');
  const out: string[] = [];
  let includeCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    let relTarget = '';
    if (trimmed.startsWith('@include ')) {
      relTarget = trimmed.slice('@include '.length).trim();
    } else if (/^@\.\.?[\\/]/.test(trimmed) && !/\s/.test(trimmed)) {
      relTarget = trimmed.slice(1).trim();
    }
    if (!relTarget || includeCount >= MAX_INCLUDES_PER_FILE) {
      out.push(line);
      continue;
    }
    relTarget = relTarget.replace(/^['"`]|['"`]$/g, '').trim();
    if (!relTarget || relTarget.includes('\0') || path.isAbsolute(relTarget)) {
      out.push(line);
      continue;
    }
    const resolvedCandidate = path.resolve(baseDir, relTarget);
    if (!isWithinBoundary(boundaryRoot, resolvedCandidate) || visited.has(resolvedCandidate)) {
      continue;
    }
    try {
      const stat = fs.lstatSync(resolvedCandidate);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0 || stat.size > MAX_SINGLE_INSTRUCTION_CHARS * 2) {
        continue;
      }
      const realCandidate = nativeRealpath(resolvedCandidate);
      if (!isWithinBoundary(boundaryRoot, realCandidate) || visited.has(realCandidate)) {
        continue;
      }
      visited.add(resolvedCandidate);
      visited.add(realCandidate);
      includeCount++;
      const childRaw = fs.readFileSync(realCandidate, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
      const expandedChild = expandSafeIncludes(childRaw, realCandidate, boundaryRoot, visited, depth + 1).trim();
      if (expandedChild) {
        out.push(expandedChild);
      }
    } catch {
      // Missing or unreadable include is skipped safely
    }
  }
  return out.join('\n');
}

function matchesActiveFiles(
  globs: readonly string[],
  workspaceRoot: string,
  activeFiles: readonly string[] | undefined
): boolean {
  if (globs.length === 0) return true;
  if (!Array.isArray(activeFiles) || activeFiles.length === 0) return false;
  const rules = parseIgnoreContent(globs.join('\n')).filter((r) => !r.negated);
  if (rules.length === 0) return false;
  const matcher = createIgnoreMatcher(workspaceRoot, rules);
  return activeFiles.some((file) => typeof file === 'string' && file.trim().length > 0 && matcher.isIgnored(file, false));
}

function readSafeInstructionFile(
  filePath: string,
  remainingBudget: number,
  boundaryRoot: string | null,
  parseFrontmatter: boolean
): { content: string; bytes: number; truncated: boolean; globs: string[]; digest: string } | null {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) return null;
    const cap = Math.min(MAX_SINGLE_INSTRUCTION_CHARS, remainingBudget);
    if (cap <= 0) return null;
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const parsed = parseFrontmatter ? parseRuleFrontmatter(raw) : { globs: [], body: raw.replace(/\r\n/g, '\n') };
    const visited = new Set<string>([path.resolve(filePath), nativeRealpath(filePath)]);
    const expanded = expandSafeIncludes(parsed.body, filePath, boundaryRoot, visited, 0);
    const redacted = redactTextSecrets(expanded).trim();
    if (!redacted) return null;
    const digest = crypto.createHash('sha256').update(redacted).digest('hex');
    const truncated = redacted.length > cap;
    const content = truncated ? `${redacted.slice(0, cap)}\n...[truncated]` : redacted;
    return { content, bytes: stat.size, truncated, globs: parsed.globs, digest };
  } catch {
    return null;
  }
}

function directoryChain(topDir: string, leafDir: string): string[] {
  const resolvedTop = path.resolve(topDir);
  const resolvedLeaf = path.resolve(leafDir);
  const rel = path.relative(resolvedTop, resolvedLeaf);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return [resolvedLeaf];
  const chain: string[] = [resolvedTop];
  if (!rel) return chain;
  let cursor = resolvedTop;
  for (const segment of rel.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    chain.push(cursor);
  }
  return chain;
}

function nativeRealpath(targetPath: string): string {
  try {
    return typeof fs.realpathSync.native === 'function'
      ? fs.realpathSync.native(targetPath)
      : fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

export function loadProjectInstructions(
  workspaceDir: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  options: LoadProjectInstructionsOptions = {}
): LoadedProjectInstructions {
  const resolvedWs = nativeRealpath(workspaceDir);
  const repoRoot = resolveGitRepoRoot(resolvedWs);
  const boundaryRoot = repoRoot ? nativeRealpath(repoRoot) : resolvedWs;
  const entries: ProjectInstructionEntry[] = [];
  const seenPaths = new Set<string>();
  const seenDigestsByDir = new Map<string, Set<string>>();
  let totalChars = 0;
  let anyTruncated = false;

  const tryAdd = (
    candidatePath: string,
    scope: 'global' | 'workspace' | 'rule' | 'personalization',
    includeBoundary: string | null
  ): void => {
    const resolved = path.resolve(candidatePath);
    if (seenPaths.has(resolved)) return;
    seenPaths.add(resolved);
    const remaining = MAX_TOTAL_INSTRUCTION_CHARS - totalChars;
    if (remaining <= 0) {
      anyTruncated = true;
      return;
    }
    const read = readSafeInstructionFile(resolved, remaining, includeBoundary, scope === 'rule');
    if (!read) return;

    if (scope === 'rule' && read.globs.length > 0) {
      const matched = matchesActiveFiles(read.globs, resolvedWs, options.activeFiles);
      if (!matched && options.includeUnmatchedScoped !== true) {
        return;
      }
    }

    // Deduplicate identical instruction bodies within the same directory (e.g. mirrored CAUSYNE.md & AGENTS.md)
    const dirKey = path.dirname(resolved);
    let dirDigests = seenDigestsByDir.get(dirKey);
    if (!dirDigests) {
      dirDigests = new Set<string>();
      seenDigestsByDir.set(dirKey, dirDigests);
    }
    if (dirDigests.has(read.digest)) return;
    dirDigests.add(read.digest);

    totalChars += read.content.length;
    if (read.truncated) anyTruncated = true;
    entries.push({
      sourcePath: resolved,
      scope,
      bytes: read.bytes,
      truncated: read.truncated,
      content: read.content,
      ...(read.globs.length > 0 ? { globs: read.globs } : {})
    });
  };

  // 1. User global instructions
  const homeDir = env.CAUSYNE_HOME && String(env.CAUSYNE_HOME).trim()
    ? path.resolve(String(env.CAUSYNE_HOME).trim())
    : causyneHome();
  const realHomeDir = nativeRealpath(homeDir);
  tryAdd(path.join(homeDir, 'CAUSYNE.md'), 'global', realHomeDir);
  tryAdd(path.join(homeDir, 'AGENTS.md'), 'global', realHomeDir);

  // 2. Hierarchical repo root -> active workspace directory
  const dirs = repoRoot ? directoryChain(repoRoot, resolvedWs) : [resolvedWs];
  for (const dir of dirs) {
    for (const filename of INSTRUCTION_FILENAMES) {
      tryAdd(path.join(dir, filename), 'workspace', boundaryRoot);
    }
    // 3. Scoped `.causyne/rules/*.md` files
    const rulesDir = path.join(dir, '.causyne', 'rules');
    try {
      const stat = fs.lstatSync(rulesDir);
      if (!stat.isSymbolicLink() && stat.isDirectory()) {
        const ruleFiles = fs.readdirSync(rulesDir)
          .filter((name) => name.toLowerCase().endsWith('.md') && !name.startsWith('.'))
          .sort()
          .slice(0, MAX_RULE_FILES);
        for (const ruleFile of ruleFiles) {
          tryAdd(path.join(rulesDir, ruleFile), 'rule', boundaryRoot);
        }
      }
    } catch { /* directory absent */ }
    // 4. Per-project Personalization (`.causyne/personalization.md`) — highest project priority
    const causyneDir = path.join(dir, '.causyne');
    try {
      const dirStat = fs.lstatSync(causyneDir);
      if (!dirStat.isSymbolicLink() && dirStat.isDirectory()) {
        tryAdd(path.join(causyneDir, 'personalization.md'), 'personalization', boundaryRoot);
      }
    } catch { /* directory absent */ }
  }

  return {
    workspaceRoot: resolvedWs,
    repoRoot,
    entries,
    totalChars,
    truncated: anyTruncated
  };
}

export function formatProjectInstructionsPrompt(loaded: LoadedProjectInstructions): string {
  if (!loaded || loaded.entries.length === 0) return '';
  const blocks = loaded.entries.map((entry) => {
    const rel = path.relative(loaded.workspaceRoot, entry.sourcePath);
    const label = entry.scope === 'global'
      ? `~/.causyne/${path.basename(entry.sourcePath)}`
      : (rel && !rel.startsWith('..') ? rel.replace(/\\/g, '/') : entry.sourcePath);
    if (entry.scope === 'personalization') {
      return `## PROJECT PERSONALIZATION — HIGH-PRIORITY BINDING CONTRACT (${safeDisplay(label)})\n${entry.content}`;
    }
    return `## Project Rules (${entry.scope}: ${safeDisplay(label)})\n${entry.content}`;
  });
  return [
    '\n\n# PROJECT PERSONALIZATION & WORKSPACE INSTRUCTIONS — TREAT AS HIGH-PRIORITY BINDING CONTRACT',
    'IMPORTANT: The developer explicitly authored these per-project Personalization and Workspace Instructions to define their project vision, mission, engineering standards, communication preferences, and non-negotiable conventions. Treat them as a BIG DEAL and strictly obey every directive below across all responses, edits, plans, and verifications—overriding generic habits whenever they do not conflict with Causyne\'s Absolute Ethical Safety Net or active permission/sandbox boundaries. Per-project Personalization (`.causyne/personalization.md`) takes highest precedence for this workspace.',
    '',
    blocks.join('\n\n')
  ].join('\n');
}

export function formatProjectRulesReport(workspaceDir: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  const loaded = loadProjectInstructions(workspaceDir, env, { includeUnmatchedScoped: true });
  if (loaded.entries.length === 0) {
    return [
      'Project Instructions & Rules',
      '  Status : none loaded',
      `  Lookup : .causyne/personalization.md, CAUSYNE.md, AGENTS.override.md, AGENTS.md, CLAUDE.md, .causyne/rules/*.md`,
      '  Tip    : Run /personalization set "<instructions>" or /init to create project rules.'
    ].join('\n');
  }
  const lines = [
    `Project Instructions & Rules (${loaded.entries.length} file(s), ${loaded.totalChars} chars${loaded.truncated ? ', budget-truncated' : ''})`,
    ''
  ];
  for (const entry of loaded.entries) {
    const scopeGlobs = entry.globs && entry.globs.length > 0 ? ` paths=[${entry.globs.map((g) => safeDisplay(g)).join(', ')}]` : '';
    lines.push(`  • [${entry.scope}] ${safeDisplay(entry.sourcePath)} (${entry.bytes} bytes${entry.truncated ? ', truncated' : ''})${scopeGlobs}`);
  }
  return lines.join('\n');
}
