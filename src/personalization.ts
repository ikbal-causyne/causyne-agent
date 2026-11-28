/**
 * Causyne Agent — Per-Project & Global Personalization + Memory Governance
 *
 * Primary behavior is per-project (workspace-scoped) so each repository/project
 * maintains its own high-priority personalization contract and memory policy
 * without leaking into unrelated workspaces:
 *   - Project instructions : `<workspaceRoot>/.causyne/personalization.md`
 *   - Project settings     : `<workspaceRoot>/.causyne/settings.json`
 *   - Global instructions  : `~/.causyne/CAUSYNE.md`
 *   - Global memory prefs  : `~/.causyne/config.json` (`memory: { enabled, allowToolAssisted }`)
 *
 * Security invariants:
 *   - Fixed allowlisted filenames only (no arbitrary path writes).
 *   - Refuses symlinks on both parent `.causyne` directory and target files.
 *   - Atomic file writes via `atomicWriteFileSync`.
 *   - Enforces 16 KiB single-file cap matching `projectInstructions.ts`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from './utils/paths.js';
import { loadConfig, saveConfig } from './config.js';
import { atomicWriteFileSync } from './infra/atomicWriter.js';
import { clearMemory, clearMemoryForWorkspace, getMemoryStats } from './memory.js';
import { episodicStore } from './memory/episodicStore.js';
import { loadProjectInstructions } from './projectInstructions.js';
import { safeDisplay } from './tui/text.js';

export type PersonalizationScope = 'project' | 'global';

export interface MemoryPreferences {
  enabled: boolean;
  allowToolAssisted: boolean;
}

export interface ProjectMemoryOverrides {
  enabled?: boolean | undefined;
  allowToolAssisted?: boolean | undefined;
}

export interface EffectiveMemoryPolicy {
  enabled: boolean;
  allowToolAssisted: boolean;
  source: 'project' | 'global';
  projectOverrides: ProjectMemoryOverrides;
  globalDefaults: MemoryPreferences;
}

export interface PersonalizationDocumentState {
  scope: PersonalizationScope;
  path: string;
  displayPath: string;
  exists: boolean;
  content: string;
  bytes: number;
  maxBytes: number;
}

export interface PersonalizationRuleSummary {
  scope: 'personalization' | 'global' | 'workspace' | 'rule';
  label: string;
  sourcePath: string;
  bytes: number;
  truncated: boolean;
  globs?: string[] | undefined;
}

export interface MemoryStatsSummary {
  projectFacts: number;
  totalFacts: number;
  projectObservations: number;
  totalObservations: number;
  projectSummaries: number;
  totalSummaries: number;
}

export interface PersonalizationOverview {
  workspaceRoot: string;
  project: PersonalizationDocumentState;
  global: PersonalizationDocumentState;
  memory: EffectiveMemoryPolicy;
  memoryStats: MemoryStatsSummary;
  activeRules: PersonalizationRuleSummary[];
}

export const MAX_PERSONALIZATION_BYTES = 16_384;
const MAX_SETTINGS_JSON_BYTES = 64 * 1024;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const EXTERNAL_TOOL_ASSISTED_NAMES = new Set([
  'web_search',
  'web_fetch',
  'browser_act',
  'search_web',
  'read_url_content',
  'browser_navigate',
  'browser_read_page',
  'browser_interact',
  'browser_extract',
  'browser_screenshot',
  'browser_tabs'
]);

function resolveHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CAUSYNE_HOME && String(env.CAUSYNE_HOME).trim();
  return override ? path.resolve(override) : causyneHome();
}

export function resolveProjectPersonalizationPath(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), '.causyne', 'personalization.md');
}

export function resolveProjectSettingsPath(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), '.causyne', 'settings.json');
}

export function resolveGlobalPersonalizationPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveHomeDir(env), 'CAUSYNE.md');
}

function assertNotSymlinkIfPresent(targetPath: string, expectedKind: 'file' | 'dir'): void {
  try {
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing symlink at ${safeDisplay(path.basename(targetPath))}`);
    }
    if (expectedKind === 'dir' && !stat.isDirectory()) {
      throw new Error(`Expected directory at ${safeDisplay(path.basename(targetPath))}`);
    }
    if (expectedKind === 'file' && !stat.isFile()) {
      throw new Error(`Expected regular file at ${safeDisplay(path.basename(targetPath))}`);
    }
  } catch (err: unknown) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as NodeJS.ErrnoException).code) : '';
    if (code === 'ENOENT') return;
    throw err;
  }
}

function ensureSafeDirectory(dirPath: string, mode: number): void {
  assertNotSymlinkIfPresent(dirPath, 'dir');
  fs.mkdirSync(dirPath, { recursive: true, mode });
  assertNotSymlinkIfPresent(dirPath, 'dir');
}

function readSafeMarkdownFile(
  filePath: string,
  scope: PersonalizationScope,
  displayPath: string
): PersonalizationDocumentState {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return {
        scope,
        path: filePath,
        displayPath,
        exists: false,
        content: '',
        bytes: 0,
        maxBytes: MAX_PERSONALIZATION_BYTES
      };
    }
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const clamped = raw.length > MAX_PERSONALIZATION_BYTES ? raw.slice(0, MAX_PERSONALIZATION_BYTES) : raw;
    return {
      scope,
      path: filePath,
      displayPath,
      exists: true,
      content: clamped,
      bytes: Buffer.byteLength(clamped, 'utf8'),
      maxBytes: MAX_PERSONALIZATION_BYTES
    };
  } catch {
    return {
      scope,
      path: filePath,
      displayPath,
      exists: false,
      content: '',
      bytes: 0,
      maxBytes: MAX_PERSONALIZATION_BYTES
    };
  }
}

function readProjectSettingsRaw(workspaceRoot: string): Record<string, unknown> {
  const settingsPath = resolveProjectSettingsPath(workspaceRoot);
  try {
    const dirPath = path.dirname(settingsPath);
    const dirStat = fs.lstatSync(dirPath);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return {};
    const stat = fs.lstatSync(settingsPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0 || stat.size > MAX_SETTINGS_JSON_BYTES) {
      return {};
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const clean = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!FORBIDDEN_KEYS.has(k)) clean[k] = v;
    }
    return { ...clean };
  } catch {
    return {};
  }
}

function writeProjectSettingsRaw(workspaceRoot: string, nextData: Record<string, unknown>): void {
  const settingsPath = resolveProjectSettingsPath(workspaceRoot);
  const dirPath = path.dirname(settingsPath);
  ensureSafeDirectory(dirPath, 0o755);
  assertNotSymlinkIfPresent(settingsPath, 'file');
  atomicWriteFileSync(settingsPath, `${JSON.stringify(nextData, null, 2)}\n`, { mode: 0o644 });
}

function readGlobalMemoryDefaults(): MemoryPreferences {
  const config = loadConfig();
  const raw = config.memory && typeof config.memory === 'object' && !Array.isArray(config.memory)
    ? (config.memory as Record<string, unknown>)
    : {};
  return {
    enabled: raw.enabled !== false,
    allowToolAssisted: raw.allowToolAssisted !== false
  };
}

function readProjectMemoryOverrides(workspaceRoot: string): ProjectMemoryOverrides {
  const rawSettings = readProjectSettingsRaw(workspaceRoot);
  const rawMem = rawSettings.memory && typeof rawSettings.memory === 'object' && !Array.isArray(rawSettings.memory)
    ? (rawSettings.memory as Record<string, unknown>)
    : {};
  const overrides: ProjectMemoryOverrides = {};
  if (typeof rawMem.enabled === 'boolean') overrides.enabled = rawMem.enabled;
  if (typeof rawMem.allowToolAssisted === 'boolean') overrides.allowToolAssisted = rawMem.allowToolAssisted;
  return overrides;
}

/**
 * Resolves the effective Causyne Memory policy for a workspace:
 * per-project overrides in `<workspace>/.causyne/settings.json` take precedence
 * over global defaults in `~/.causyne/config.json`.
 */
export function resolveEffectiveMemoryPolicy(workspaceRoot?: string): EffectiveMemoryPolicy {
  const globalDefaults = readGlobalMemoryDefaults();
  const projectOverrides = workspaceRoot ? readProjectMemoryOverrides(workspaceRoot) : {};
  const hasProjectOverride =
    typeof projectOverrides.enabled === 'boolean' || typeof projectOverrides.allowToolAssisted === 'boolean';
  return {
    enabled: typeof projectOverrides.enabled === 'boolean' ? projectOverrides.enabled : globalDefaults.enabled,
    allowToolAssisted: typeof projectOverrides.allowToolAssisted === 'boolean'
      ? projectOverrides.allowToolAssisted
      : globalDefaults.allowToolAssisted,
    source: hasProjectOverride ? 'project' : 'global',
    projectOverrides,
    globalDefaults
  };
}

/**
 * Returns true if a tool invocation brings external/untrusted context
 * (MCP servers, web search, web fetch, or live web browsing), which is gated
 * when `allowToolAssisted` memory generation is turned off.
 */
export function isExternalToolAssistedToolName(toolName: string): boolean {
  const normalized = String(toolName || '').trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith('mcp__') || normalized.startsWith('mcp_') || normalized.startsWith('mcp:')) {
    return true;
  }
  return EXTERNAL_TOOL_ASSISTED_NAMES.has(normalized);
}

/**
 * Atomically saves project-scoped (`.causyne/personalization.md`) or global (`~/.causyne/CAUSYNE.md`)
 * personalization instructions. Refuses symlinks and enforces the 16 KiB size ceiling.
 */
export function savePersonalizationInstructions(
  workspaceRoot: string,
  scope: PersonalizationScope,
  rawContent: string,
  env: NodeJS.ProcessEnv = process.env
): PersonalizationDocumentState {
  if (typeof rawContent !== 'string') {
    throw new Error('Personalization instructions must be a string.');
  }
  if (rawContent.includes('\0')) {
    throw new Error('Personalization instructions must not contain NUL bytes.');
  }
  const normalized = rawContent.replace(/\r\n/g, '\n');
  const byteLen = Buffer.byteLength(normalized, 'utf8');
  if (byteLen > MAX_PERSONALIZATION_BYTES) {
    throw new Error(`Personalization instructions exceed maximum size (${MAX_PERSONALIZATION_BYTES} bytes).`);
  }

  const targetPath = scope === 'global'
    ? resolveGlobalPersonalizationPath(env)
    : resolveProjectPersonalizationPath(workspaceRoot);
  const displayPath = scope === 'global' ? '~/.causyne/CAUSYNE.md' : '.causyne/personalization.md';
  const dirPath = path.dirname(targetPath);

  if (normalized.trim().length === 0) {
    assertNotSymlinkIfPresent(dirPath, 'dir');
    assertNotSymlinkIfPresent(targetPath, 'file');
    try {
      if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    } catch {
      // Ignore if absent
    }
    return readSafeMarkdownFile(targetPath, scope, displayPath);
  }

  ensureSafeDirectory(dirPath, scope === 'global' ? 0o700 : 0o755);
  assertNotSymlinkIfPresent(targetPath, 'file');
  const payload = normalized.endsWith('\n') ? normalized : `${normalized}\n`;
  atomicWriteFileSync(targetPath, payload, { mode: scope === 'global' ? 0o600 : 0o644 });
  return readSafeMarkdownFile(targetPath, scope, displayPath);
}

/**
 * Updates memory preferences for either `'project'` (`<workspace>/.causyne/settings.json`)
 * or `'global'` (`~/.causyne/config.json`). Passing `null` on a project field clears the
 * per-project override so it inherits the global default.
 */
export function saveMemoryPreferences(
  workspaceRoot: string,
  scope: PersonalizationScope,
  patch: { enabled?: boolean | null | undefined; allowToolAssisted?: boolean | null | undefined }
): EffectiveMemoryPolicy {
  if (scope === 'global') {
    const config = loadConfig();
    const current = readGlobalMemoryDefaults();
    const next: MemoryPreferences = {
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
      allowToolAssisted: typeof patch.allowToolAssisted === 'boolean'
        ? patch.allowToolAssisted
        : current.allowToolAssisted
    };
    config.memory = next;
    saveConfig(config);
    return resolveEffectiveMemoryPolicy(workspaceRoot);
  }

  const settings = readProjectSettingsRaw(workspaceRoot);
  const currentMem = settings.memory && typeof settings.memory === 'object' && !Array.isArray(settings.memory)
    ? { ...(settings.memory as Record<string, unknown>) }
    : {};

  if (patch.enabled === null) {
    delete currentMem.enabled;
  } else if (typeof patch.enabled === 'boolean') {
    currentMem.enabled = patch.enabled;
  }

  if (patch.allowToolAssisted === null) {
    delete currentMem.allowToolAssisted;
  } else if (typeof patch.allowToolAssisted === 'boolean') {
    currentMem.allowToolAssisted = patch.allowToolAssisted;
  }

  if (Object.keys(currentMem).length === 0) {
    delete settings.memory;
  } else {
    settings.memory = currentMem;
  }
  writeProjectSettingsRaw(workspaceRoot, settings);
  return resolveEffectiveMemoryPolicy(workspaceRoot);
}

/**
 * Collects live memory counts across persistent facts (`memory.json`) and
 * episodic observations/summaries (`episodic-memory.json`).
 */
export function collectMemoryStats(workspaceRoot: string): MemoryStatsSummary {
  const factStats = getMemoryStats(workspaceRoot);
  const epStats = episodicStore.getStats(workspaceRoot);
  return {
    projectFacts: factStats.projectFacts,
    totalFacts: factStats.totalFacts,
    projectObservations: epStats.projectObservations,
    totalObservations: epStats.totalObservations,
    projectSummaries: epStats.projectSummaries,
    totalSummaries: epStats.totalSummaries
  };
}

/**
 * Deletes stored Causyne memories for either the active project (`'project'`)
 * or across all projects (`'all'`).
 */
export function deleteCausyneMemories(
  workspaceRoot: string,
  scope: 'project' | 'all' = 'project'
): {
  scope: 'project' | 'all';
  factsRemoved: number;
  observationsRemoved: number;
  summariesRemoved: number;
  memoryStats: MemoryStatsSummary;
} {
  let factsRemoved = 0;
  let observationsRemoved = 0;
  let summariesRemoved = 0;

  if (scope === 'all') {
    const beforeFacts = getMemoryStats(workspaceRoot).totalFacts;
    clearMemory();
    factsRemoved = beforeFacts;
    const epCleared = episodicStore.clearAll();
    observationsRemoved = epCleared.observationsRemoved;
    summariesRemoved = epCleared.summariesRemoved;
  } else {
    factsRemoved = clearMemoryForWorkspace(workspaceRoot);
    const epCleared = episodicStore.clearProject(workspaceRoot);
    observationsRemoved = epCleared.observationsRemoved;
    summariesRemoved = epCleared.summariesRemoved;
  }

  return {
    scope,
    factsRemoved,
    observationsRemoved,
    summariesRemoved,
    memoryStats: collectMemoryStats(workspaceRoot)
  };
}

/**
 * Returns the full Personalization + Memory state for Web Studio GUI and CLI inspection.
 */
export function readPersonalizationOverview(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env
): PersonalizationOverview {
  const resolvedWs = path.resolve(workspaceRoot);
  const projectDoc = readSafeMarkdownFile(
    resolveProjectPersonalizationPath(resolvedWs),
    'project',
    '.causyne/personalization.md'
  );
  const globalDoc = readSafeMarkdownFile(
    resolveGlobalPersonalizationPath(env),
    'global',
    '~/.causyne/CAUSYNE.md'
  );
  const loaded = loadProjectInstructions(resolvedWs, env, { includeUnmatchedScoped: true });
  const activeRules: PersonalizationRuleSummary[] = loaded.entries.map((entry) => {
    const rel = path.relative(loaded.workspaceRoot, entry.sourcePath);
    const label = entry.scope === 'global'
      ? `~/.causyne/${path.basename(entry.sourcePath)}`
      : (rel && !rel.startsWith('..') ? rel.replace(/\\/g, '/') : entry.sourcePath);
    return {
      scope: entry.scope,
      label,
      sourcePath: entry.sourcePath,
      bytes: entry.bytes,
      truncated: entry.truncated,
      ...(entry.globs && entry.globs.length > 0 ? { globs: entry.globs } : {})
    };
  });

  return {
    workspaceRoot: resolvedWs,
    project: projectDoc,
    global: globalDoc,
    memory: resolveEffectiveMemoryPolicy(resolvedWs),
    memoryStats: collectMemoryStats(resolvedWs),
    activeRules
  };
}
