import path from 'node:path';

export interface ScopedFactEntry {
  text: string;
  workspace?: string | undefined;
  createdAt?: number | undefined;
}

export interface PersistentMemoryData {
  facts: string[];
  entries?: ScopedFactEntry[] | undefined;
}

export interface RecordFactOptions {
  workspace?: string | undefined;
  nowMs?: number | undefined;
  maxFacts?: number | undefined;
}

export interface FormatMemoryOptions {
  workspaceRoot?: string | undefined;
  maxFacts?: number | undefined;
  maxChars?: number | undefined;
}

const DEFAULT_MAX_FACTS = 100;
const DEFAULT_CONTEXT_MAX_FACTS = 12;
const DEFAULT_CONTEXT_MAX_CHARS = 1800;

const TEST_JUNK_PATTERN = /^test fact\b/i;
const HISTORICAL_DELIVERABLE_PATTERN = /^(?:(?:Re)?Built|Upgraded|Deployed|Implemented)\b/i;
const WINDOWS_ABS_PATH_PATTERN = /^[A-Za-z]:\\/;

function normalizeWorkspace(workspace?: string | null): string | undefined {
  if (typeof workspace !== 'string') return undefined;
  const trimmed = workspace.trim();
  if (!trimmed) return undefined;
  return path.resolve(trimmed);
}

function isPathWithinOrSame(candidatePath: string, rootPath: string): boolean {
  const rel = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function extractEmbeddedAbsolutePaths(text: string): string[] {
  const found: string[] = [];
  const posixRoots = ['/Users/', '/home/', '/private/', '/var/', '/opt/', '/srv/', '/workspace/', '/repos/'];
  const tokens = text.split(/[\s()`'",;<>\[\]]+/);
  for (const raw of tokens) {
    if (!raw) continue;
    if (posixRoots.some(prefix => raw.startsWith(prefix)) || WINDOWS_ABS_PATH_PATTERN.test(raw)) {
      found.push(raw);
    }
  }
  return found;
}

export function normalizeMemoryData(raw: unknown): PersistentMemoryData {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rawFacts = Array.isArray(obj.facts) ? obj.facts : [];
  const facts: string[] = [];
  const seenFacts = new Set<string>();
  for (const item of rawFacts) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seenFacts.has(trimmed)) continue;
    seenFacts.add(trimmed);
    facts.push(trimmed);
  }

  const rawEntries = Array.isArray(obj.entries) ? obj.entries : [];
  const entries: ScopedFactEntry[] = [];
  const seenEntries = new Set<string>();
  for (const item of rawEntries) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const text = typeof rec.text === 'string' ? rec.text.trim() : '';
    if (!text) continue;
    const workspace = normalizeWorkspace(typeof rec.workspace === 'string' ? rec.workspace : undefined);
    const createdAt = typeof rec.createdAt === 'number' && Number.isFinite(rec.createdAt) ? rec.createdAt : undefined;
    const dedupKey = `${workspace || '*'}\0${text}`;
    if (seenEntries.has(dedupKey)) continue;
    seenEntries.add(dedupKey);
    entries.push({
      text,
      ...(workspace ? { workspace } : {}),
      ...(createdAt !== undefined ? { createdAt } : {})
    });
  }

  return { facts, ...(entries.length > 0 ? { entries } : {}) };
}

export function recordScopedFact(
  rawMemory: unknown,
  factText: string,
  options: RecordFactOptions = {}
): { memory: PersistentMemoryData; alreadyKnown: boolean } {
  const memory = normalizeMemoryData(rawMemory);
  const text = String(factText || '').trim();
  const maxFacts = Math.max(1, options.maxFacts ?? DEFAULT_MAX_FACTS);
  const workspace = normalizeWorkspace(options.workspace);
  const nowMs = typeof options.nowMs === 'number' && Number.isFinite(options.nowMs) ? options.nowMs : Date.now();

  if (!text) {
    return { memory, alreadyKnown: true };
  }

  const entries = [...(memory.entries || [])];
  const existingEntry = entries.find(e => e.text === text && (e.workspace || '') === (workspace || ''));
  const alreadyKnown = memory.facts.includes(text) && Boolean(!workspace || existingEntry);

  if (!memory.facts.includes(text)) {
    memory.facts.push(text);
    while (memory.facts.length > maxFacts) {
      memory.facts.shift();
    }
  }

  if (!existingEntry) {
    entries.push({
      text,
      ...(workspace ? { workspace } : {}),
      createdAt: nowMs
    });
    while (entries.length > maxFacts) {
      entries.shift();
    }
  } else {
    existingEntry.createdAt = nowMs;
  }

  return {
    memory: {
      facts: memory.facts,
      entries
    },
    alreadyKnown
  };
}

function isFactRelevantToWorkspace(
  text: string,
  entry: ScopedFactEntry | undefined,
  resolvedWorkspace: string | undefined
): boolean {
  if (!text || TEST_JUNK_PATTERN.test(text)) return false;
  if (!resolvedWorkspace) return true;

  if (entry?.workspace) {
    return path.resolve(entry.workspace) === resolvedWorkspace;
  }

  const embeddedPaths = extractEmbeddedAbsolutePaths(text);
  if (embeddedPaths.length > 0) {
    const anyMatchesCurrent = embeddedPaths.some(p => isPathWithinOrSame(p, resolvedWorkspace));
    if (!anyMatchesCurrent) return false;
  }

  if (HISTORICAL_DELIVERABLE_PATTERN.test(text)) {
    const projectName = path.basename(resolvedWorkspace).toLowerCase();
    const mentionsWorkspacePath = text.includes(resolvedWorkspace)
      || (projectName.length >= 4 && text.toLowerCase().includes(projectName));
    if (!mentionsWorkspacePath) return false;
  }

  return true;
}

export function formatMemoryContext(
  rawMemory: unknown,
  options?: string | FormatMemoryOptions
): string {
  const memory = normalizeMemoryData(rawMemory);
  const opts: FormatMemoryOptions = typeof options === 'string'
    ? { workspaceRoot: options }
    : (options || {});
  const resolvedWorkspace = normalizeWorkspace(opts.workspaceRoot);
  const maxFacts = Math.max(1, opts.maxFacts ?? DEFAULT_CONTEXT_MAX_FACTS);
  const maxChars = Math.max(200, opts.maxChars ?? DEFAULT_CONTEXT_MAX_CHARS);

  const entryByText = new Map<string, ScopedFactEntry>();
  for (const entry of memory.entries || []) {
    if (resolvedWorkspace && entry.workspace && path.resolve(entry.workspace) === resolvedWorkspace) {
      entryByText.set(entry.text, entry);
    } else if (!entryByText.has(entry.text)) {
      entryByText.set(entry.text, entry);
    }
  }

  const relevant: string[] = [];
  for (const factText of memory.facts) {
    if (isFactRelevantToWorkspace(factText, entryByText.get(factText), resolvedWorkspace)) {
      relevant.push(factText);
    }
  }

  if (relevant.length === 0) {
    return 'No workspace-relevant prior memory facts available.';
  }

  // Keep the most recent relevant facts within the character budget.
  const selectedReversed: string[] = [];
  let charCount = 0;
  for (let i = relevant.length - 1; i >= 0 && selectedReversed.length < maxFacts; i--) {
    const item = relevant[i]!;
    if (charCount + item.length > maxChars && selectedReversed.length > 0) break;
    charCount += item.length;
    selectedReversed.push(item);
  }
  const selected = selectedReversed.reverse();
  return selected.map((fact, index) => `${index + 1}. ${fact}`).join('\n');
}
