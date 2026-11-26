// Completion for the chat prompt: `/` commands and `@` file paths.
//
// Two providers, one picker. The command provider reads the SAME registry that
// executes commands (src/commands.js), so a command can never appear in the
// picker and then not exist — there is no second list to drift.
//
// SECURITY: a filename is untrusted input. `touch $'evil\e[31m.txt'` is legal on
// every POSIX filesystem, and offering that name would inject an escape both
// into the picker and into the user's edit buffer. Anything that does not
// survive sanitize() unchanged is dropped, because a path we cannot print
// safely is also a path we cannot safely type.
//
// Pure Node. No dependency, no shell.

import fs from 'fs';
import path from 'path';
import { listCommands } from '../commands.js';
import { listCompiledSkills as listSkillsForCompletion } from '../skillsManager.js';
import { sanitize, shortenHome } from './text.js';
import { WorkspaceFileIndex } from './workspaceFileIndex.js';
import { detectInlineSlashTrigger, type SlashTrigger } from './inlineSlash.js';
export { WorkspaceFileIndex as FileIndex };

export const MAX_VISIBLE = 8;

export interface CompletionItem {
  value: string;
  match?: string;
  aliases?: string[];
  label: string;
  description: string;
  isCommand?: boolean;
}

export interface FileTrigger {
  kind: 'file';
  quote: string | null;
  start: number;
  query: string;
}

export type CompletionTrigger = SlashTrigger | FileTrigger;

export type CompletionSuggestion = CompletionTrigger & {
  items: CompletionItem[];
  total: number;
};

export interface SuggestOptions {
  root?: string | undefined;
  index?: WorkspaceFileIndex | null | undefined;
  focusDir?: string | null | undefined;
}

export interface PickerRow {
  item: CompletionItem;
  selected: boolean;
  label: string;
  description: string;
}

type RankedCompletionItems = CompletionItem[] & { total: number };

// Directories that are never worth indexing. Walking node_modules turns a
// 40 ms index into a 40 s one and buries real files under vendored ones.
const SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.gradle',
  '.idea', '.cache', 'coverage', 'vendor', 'Pods', '.causyne'
]);

/** A value is offerable only if printing it changes nothing. */
export function isTerminalSafe(value: unknown): boolean {
  const text = String(value == null ? '' : value);
  return text.length > 0 && sanitize(text) === text;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Score `candidate` against `query`, or -1 for no match.
 *
 * Prefix beats subsequence, and a match on the basename beats one buried in a
 * parent directory. Substring containment is deliberately NOT the test on its
 * own — rules.json ZM-09: a naive `includes()` both over-matches unrelated
 * paths and under-ranks the file the user meant.
 */
export function score(candidate: string, query: string): number {
  if (typeof candidate !== 'string') return -1;
  if (typeof query !== 'string' || !query) return 0;
  const full = (candidate.length > 1024 ? candidate.slice(0, 1024) : candidate).toLocaleLowerCase();
  const needle = (query.length > 256 ? query.slice(0, 256) : query).toLocaleLowerCase();
  const leaf = full.replace(/\/$/, '').split('/').at(-1) || '';
  const isDirectory = candidate.endsWith('/');
  const pathPenalty = Math.min(candidate.length, 180);
  const fileBonus = isDirectory ? 0 : 20;

  if (leaf === needle) return 1800 + fileBonus - pathPenalty;
  if (leaf.startsWith(needle)) return 1500 + fileBonus - pathPenalty;
  if (leaf.includes(needle)) return 1200 + fileBonus - pathPenalty;
  if (full.startsWith(needle)) return 1050 + fileBonus - pathPenalty;
  if (full.includes(needle)) return 900 + fileBonus - pathPenalty;

  // Fallback: a bounded subsequence match for abbreviations such as tuich.
  let cursor = 0;
  let gaps = 0;
  for (const character of full) {
    if (character === needle[cursor]) {
      cursor++;
      if (cursor === needle.length) return 400 - gaps - pathPenalty;
    } else if (cursor > 0) {
      gaps++;
    }
  }
  return -1;
}

/**
 * Score, sort and cap — and report how many matched BEFORE the cap.
 *
 * If focusDir is supplied (e.g. active subproject like 'pixel2d games'),
 * items belonging to that directory receive a priority boost so the user's
 * active workspace files are never buried by unrelated paths.
 */
function rank(items: readonly CompletionItem[], query: string, limit = 50, focusDir: string | null = null): RankedCompletionItems {
  const scored: Array<{ item: CompletionItem; value: number }> = [];
  const focusPrefix = focusDir
    ? (focusDir.endsWith('/') ? focusDir.toLowerCase() : focusDir.toLowerCase() + '/')
    : null;

  for (const item of items) {
    const val = item.match !== undefined ? item.match : item.value;
    let value = score(val, query);
    let matchedAlias: string | null = null;

    if (Array.isArray(item.aliases) && query) {
      for (const alias of item.aliases) {
        const aliasScore = score(alias, query);
        if (aliasScore > value) {
          value = aliasScore;
          matchedAlias = alias;
        }
      }
    }

    if (value >= 0) {
      if (item.isCommand) {
        value += 2000;
      }
      if (focusPrefix && val.toLowerCase().startsWith(focusPrefix)) {
        value += 90;
      }
      const resultItem: CompletionItem = matchedAlias
        ? { ...item, description: `(alias: /${matchedAlias}) ${item.description}` }
        : item;
      scored.push({ item: resultItem, value });
    }
  }
  scored.sort((a, b) => b.value - a.value || a.item.value.localeCompare(b.item.value));
  const ranked = scored.slice(0, limit).map((entry) => entry.item) as RankedCompletionItems;
  ranked.total = scored.length;
  return ranked;
}

// A command's own vocabulary is bounded and small — a few hundred at most — and
// every entry is reachable by scrolling the picker. Capping it at the file-index
// limit hid two thirds of the skill library behind a number that denied it was
// there.
const ARGUMENT_LIMIT = 500;

// ---------------------------------------------------------------------------
// `/` commands
// ---------------------------------------------------------------------------

// Below this many characters a query is still a command prefix, not a skill search.
const SKILL_QUERY_MIN = 3;

function commandItems(query = ''): CompletionItem[] {
  // High-frequency accelerator commands prioritized at the top on a bare '/'.
  // First 8 items fit directly on the opening page (MAX_VISIBLE = 8):
  // /model, /variant, /sessions, /continuum, /usage, /skills, /plugins, /cortex
  // followed immediately by everyday mid-session accelerators.
  const SUGGESTED_ORDER = [
    'model',
    'variant',
    'sessions',
    'continuum',
    'usage',
    'skills',
    'plugins',
    'cortex',
    'gui',
    'compact',
    'undo',
    'diff',
    'checkpoints',
    'context',
    'plans',
    'thinking',
    'mode',
    'mcp',
    'new',
    'fork',
    'clear',
    'stop',
    'status',
    'doctor',
    'setup',
    'help'
  ];
  const allCommands = listCommands('terminal');

  const sorted = allCommands.slice().sort((a, b) => {
    const idxA = SUGGESTED_ORDER.indexOf(a.name);
    const idxB = SUGGESTED_ORDER.indexOf(b.name);
    const scoreA = idxA === -1 ? 999 : idxA;
    const scoreB = idxB === -1 ? 999 : idxB;
    return scoreA - scoreB;
  });

  const commands: CompletionItem[] = [];
  const seenLabels = new Set<string>();

  for (const command of sorted) {
    if (!isTerminalSafe(command.name)) continue;
    const primaryLabel = '/' + command.name;
    if (!seenLabels.has(primaryLabel)) {
      seenLabels.add(primaryLabel);
      commands.push({
        value: primaryLabel,
        match: command.name,
        aliases: Array.isArray(command.aliases) ? command.aliases.filter(isTerminalSafe) : [],
        label: primaryLabel,
        description: sanitize(command.description || ''),
        isCommand: true
      });
    }
  }

  // On a bare '/' (no query entered), keep the menu purely focused on genuine slash commands.
  // Skills belong in `/skills` and must never pollute the top-level palette.
  if (!query) {
    return commands;
  }

  // When a user explicitly searches for a skill keyword (e.g. `/docker`), offer matching skills,
  // but commands always retain strict priority in ranking.
  //
  // Skills match only on a CONTIGUOUS piece of their own id, and only once the
  // query is long enough to mean something. Loose subsequence matching over
  // "id + domain" let `/p` and `/plu` pull 70+ unrelated skills into the
  // command palette ("... 72 more"), burying the command being typed.
  const needle = query.toLowerCase();
  if (needle.length < SKILL_QUERY_MIN) return commands;
  const skills: CompletionItem[] = listSkillsForCompletion()
    .filter((skill) =>
      isTerminalSafe(skill.id) &&
      isTerminalSafe(skill.domain) &&
      String(skill.id || '').toLowerCase().includes(needle)
    )
    .map((skill) => ({
      value: `/skills ${skill.domain}/${skill.id}`,
      match: skill.id,
      label: `/${skill.id}`,
      description: sanitize(skill.description || ''),
      isCommand: false
    }));

  return commands.concat(skills);
}

/**
 * A command's own argument suggestions.
 *
 * The command owns them: it knows what its argument means and this module does
 * not. Anything a command returns is treated as untrusted display text and
 * sanitised, the same as a filename.
 */
function argumentItems(name: string): CompletionItem[] {
  const command = listCommands('terminal')
    .find((candidate) => (candidate.name === name || (Array.isArray(candidate.aliases) && candidate.aliases.includes(name))) && isTerminalSafe(candidate.name));
  if (!command || typeof command.complete !== 'function') return [];

  let produced: unknown;
  try {
    produced = command.complete();
  } catch {
    return []; // a broken completer must never take the prompt down
  }
  if (!Array.isArray(produced)) return [];

  return produced
    .filter((entry): entry is { value: string; match?: string; label?: string; description?: string } =>
      Boolean(entry) && typeof (entry as { value?: unknown }).value === 'string' && isTerminalSafe((entry as { value: string }).value)
    )
    .map((entry) => ({
      value: entry.value,
      match: entry.match === undefined ? entry.value : entry.match,
      label: sanitize(entry.label === undefined ? entry.value : entry.label),
      description: sanitize(entry.description || '')
    }));
}

// ---------------------------------------------------------------------------
// `@` files
// ---------------------------------------------------------------------------

// FileIndex is now owned by src/tui/workspaceFileIndex.ts.

/**
 * Resolve both the authorized root and candidate to physical paths before
 * touching a directory. Lexical path.resolve() alone follows symlinks outside
 * the workspace and can leak private filenames through @ completion.
 */
function isPhysicalChild(root: string, candidate: string): boolean {
  try {
    const base = fs.realpathSync(root);
    const target = fs.realpathSync(candidate);
    const relative = path.relative(base, target);
    return relative === '' || (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

/** Instant, shell-style completion of one directory level. */
function directoryItems(root: string, partial: string): CompletionItem[] {
  if (typeof root !== 'string' || !root || root.includes('\0') || typeof partial !== 'string' || partial.includes('\0')) return [];
  const slash = partial.lastIndexOf('/');
  const dirPart = slash === -1 ? '' : partial.slice(0, slash + 1);
  const target = path.resolve(root, dirPart);

  // Never offer paths outside the workspace root, whatever the user typed.
  const relativeToRoot = path.relative(root, target);
  if (relativeToRoot === '..' || relativeToRoot.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeToRoot) || !isPhysicalChild(root, target)) return [];

  let listing: fs.Dirent[];
  try {
    listing = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return [];
  }

  const items: CompletionItem[] = [];
  for (const entry of listing) {
    if (entry.name.startsWith('.')) continue;
    const candidate = path.join(target, entry.name);
    // A lexical entry can be a symlink to a private directory. Do not offer
    // any symlink whose physical target leaves the active workspace.
    if (entry.isSymbolicLink() && !isPhysicalChild(root, candidate)) continue;
    let isDirectory = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try { isDirectory = fs.statSync(candidate).isDirectory(); }
      catch { continue; }
    }
    if (isDirectory && SKIP_DIRECTORIES.has(entry.name)) continue;
    const value = dirPart + entry.name + (isDirectory ? '/' : '');
    if (!isTerminalSafe(value)) continue;
    items.push({
      value,
      match: value,
      label: value,
      description: isDirectory ? 'directory' : ''
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Trigger detection
// ---------------------------------------------------------------------------

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

/**
 * Find a slash command or @ reference at the current caret position.
 * Slash detection works at any whitespace-delimited token boundary. Execution
 * remains exclusive to explicit selection; normal prompt dispatch is unchanged.
 */
export function detectTrigger(text: unknown, cursor: number): CompletionTrigger | null {
  const input = String(text == null ? '' : text);
  const pos = clampCursor(input, cursor);
  const before = input.slice(0, pos);
  const slash = detectInlineSlashTrigger(input, pos);
  if (slash) return slash;

  const scanWindow = before.length > 2048 ? before.slice(-2048) : before;

  // 1. Quoted @ file mention: @"pixel2d games/ or @'pixel2d games/
  // Supports spaces in directory or file names
  const quotedMention = scanWindow.match(/(?:^|\s)@(["'])([^"']*)$/);
  if (quotedMention && quotedMention[1] !== undefined && quotedMention[2] !== undefined) {
    const quote = quotedMention[1];
    const query = quotedMention[2];
    return {
      kind: 'file',
      quote,
      start: pos - query.length - 2, // accounts for @ and quote char
      query
    };
  }

  // 2. Unquoted @ file mention: @alpha or @src/
  const mention = scanWindow.match(/(?:^|\s)@([^\s@"']*)$/);
  if (mention && mention[1] !== undefined) {
    return {
      kind: 'file',
      quote: null,
      start: pos - mention[1].length - 1,
      query: mention[1]
    };
  }
  return null;
}

/**
 * Suggestions for the cursor position, or null when nothing should open.
 *
 * Synchronous by design: a picker that appears a beat after you type feels
 * broken. The file index is consulted only if it has already finished.
 */
export function suggest(text: unknown, cursor: number, options: SuggestOptions = {}): CompletionSuggestion | null {
  const safeOptions = options && typeof options === 'object' ? options : {};
  const trigger = detectTrigger(text, cursor);
  if (!trigger) return null;

  if (trigger.kind === 'command') {
    const pool = commandItems(trigger.query);
    if (!trigger.query) {
      // Preserve curated accelerator order on bare '/' instead of re-sorting alphabetically.
      const items = pool.slice(0, 100);
      if (items.length === 0) return null;
      return { ...trigger, items, total: pool.length };
    }
    const items = rank(pool, trigger.query, 100);
    if (items.length === 0) return null;
    return { ...trigger, items, total: items.total };
  }

  if (trigger.kind === 'command-argument') {
    const pool = argumentItems(trigger.command);
    if (!trigger.query) {
      // Preserve command-defined logical order (e.g. off -> low -> medium -> high -> xhigh -> max).
      const items = pool.slice(0, ARGUMENT_LIMIT);
      if (items.length === 0) return null;
      return { ...trigger, items, total: pool.length };
    }
    const items = rank(pool, trigger.query, ARGUMENT_LIMIT);
    if (items.length === 0) return null;
    return { ...trigger, items, total: items.total };
  }

  const root = safeOptions.root || process.cwd();
  const index = safeOptions.index;
  const rawFocusDir = safeOptions.focusDir ? String(safeOptions.focusDir).replace(/\/+$/, '') : null;
  const focusDir = rawFocusDir && isTerminalSafe(rawFocusDir) ? rawFocusDir : null;
  if (index) void index.ensure();

  let pool: CompletionItem[];
  if (index && index.isReady && trigger.query) {
    pool = index.candidates(trigger.query)
      .filter((relative) => isTerminalSafe(relative))
      .map((relative) => ({
        value: relative,
        match: relative,
        label: relative,
        description: relative.endsWith('/') ? 'directory' : ''
      }));
  } else {
    pool = directoryItems(root, trigger.query);
    if (focusDir) {
      const focusTarget = path.resolve(root, focusDir);
      try {
        if (isPhysicalChild(root, focusTarget) && fs.statSync(focusTarget).isDirectory()) {
          const focusedItems = directoryItems(focusTarget, trigger.query).map((item) => ({
            ...item,
            value: `${focusDir}/${item.value}`,
            match: `${focusDir}/${item.value}`,
            label: `${focusDir}/${item.label}`
          }));
          pool = pool.concat(focusedItems);
        }
      } catch {
        // ignore inaccessible focusDir
      }
    }
  }

  // If index had no ready matches for a path with slashes, fall back to directory items
  if (pool.length === 0 && trigger.query.includes('/')) {
    pool = directoryItems(root, trigger.query);
  }

  const items = rank(pool, trigger.query, 500, focusDir);
  if (items.length === 0) return null;
  return { ...trigger, items, total: items.total };
}

/** Replace the trigger span with the chosen value. */
export function applyCompletion(
  text: unknown,
  cursor: number,
  trigger: CompletionTrigger,
  item: { value: string }
): { text: string; cursor: number } {
  const input = String(text == null ? '' : text);
  const pos = clampCursor(input, cursor);
  const start = Math.max(0, Math.min(pos, Number.isFinite(trigger?.start) ? Math.floor(trigger.start) : 0));
  if (trigger.kind === 'command-argument') {
    const head = input.slice(0, start);
    const tail = input.slice(pos);
    const complete = item.value.includes('/');
    const replaced = head + item.value + (complete ? ' ' : '');
    return { text: replaced + tail, cursor: replaced.length };
  }

  if (trigger.kind === 'command') {
    const head = input.slice(0, start);
    const tail = input.slice(pos);
    const replaced = head + item.value + ' ';
    return { text: replaced + tail, cursor: replaced.length };
  }

  // trigger.kind === 'file'
  const head = input.slice(0, start);
  const tail = input.slice(pos);
  const isDir = item.value.endsWith('/');
  const hasSpace = item.value.includes(' ');
  const quote = trigger.quote || (hasSpace ? '"' : '');

  let value: string;
  let suffix: string;
  if (quote) {
    if (isDir) {
      // Drilling into directory: open quote without closing quote, no trailing space
      value = `@${quote}${item.value}`;
      suffix = '';
    } else {
      // Complete file: close quote and add trailing space
      value = `@${quote}${item.value}${quote}`;
      suffix = ' ';
    }
  } else {
    value = '@' + item.value;
    suffix = isDir ? '' : ' ';
  }

  const replaced = head + value + suffix;
  return { text: replaced + tail, cursor: replaced.length };
}

/** Rows for the picker, already bounded and safe to print. */
export function renderPicker(items: readonly CompletionItem[] | null | undefined, selected: number, _width?: number): PickerRow[] {
  if (!Array.isArray(items) || items.length === 0) return [];
  const safeSelected = Number.isFinite(selected)
    ? Math.max(0, Math.min(items.length - 1, Math.floor(selected)))
    : 0;
  const start = Math.max(0, Math.min(safeSelected - MAX_VISIBLE + 1, items.length - MAX_VISIBLE));
  const windowItems = items.slice(start, start + MAX_VISIBLE);
  const cleanSingleLine = (text: unknown): string => sanitize(String(text == null ? '' : text)).replace(/[\r\n]+/g, ' ');
  return windowItems.map((item, offset) => ({
    item,
    selected: start + offset === safeSelected,
    label: cleanSingleLine(shortenHome(String(item?.label ?? item?.value ?? ''))),
    description: cleanSingleLine(item?.description ?? '')
  }));
}
