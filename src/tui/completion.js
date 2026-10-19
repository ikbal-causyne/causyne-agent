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
import fsp from 'fs/promises';
import path from 'path';
import { listCommands } from '../commands.js';
import { listCompiledSkills as listSkillsForCompletion } from '../skillsManager.js';
import { sanitize, shortenHome } from './text.js';

export const MAX_VISIBLE = 8;

// Directories that are never worth indexing. Walking node_modules turns a
// 40 ms index into a 40 s one and buries real files under vendored ones.
const SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.gradle',
  '.idea', '.cache', 'coverage', 'vendor', 'Pods', '.causyne'
]);

const MAX_INDEX_ENTRIES = 20000;
const MAX_INDEX_DEPTH = 12;

/** A value is offerable only if printing it changes nothing. */
export function isTerminalSafe(value) {
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
export function score(candidate, query) {
  if (!query) return 0;
  const haystack = candidate.toLowerCase();
  const needle = query.toLowerCase();

  if (haystack.startsWith(needle)) return 1000 - candidate.length;

  const base = haystack.slice(haystack.lastIndexOf('/') + 1);
  if (base.startsWith(needle)) return 800 - candidate.length;
  if (base.includes(needle)) return 600 - candidate.length;

  // Subsequence: every character of the query in order, gaps allowed. This is
  // what lets "tuich" find "tui/chatRenderer.js".
  let index = 0;
  let gaps = 0;
  for (const character of haystack) {
    if (character === needle[index]) {
      index += 1;
      if (index === needle.length) return 400 - gaps - candidate.length;
    } else if (index > 0) {
      gaps += 1;
    }
  }
  return -1;
}

/**
 * Score, sort and cap — and report how many matched BEFORE the cap.
 *
 * The cap exists for the file index, which can hold tens of thousands of paths.
 * But the picker's "… N more" line was computed from the capped array, so with
 * 115 skill entries it announced "42 more" when 107 were reachable by scrolling.
 * A count that is wrong is worse than no count: it tells the user to stop
 * looking. The total travels with the items so the caller can say the truth.
 */
function rank(items, query, limit = 50) {
  const scored = [];
  for (const item of items) {
    const value = score(item.match !== undefined ? item.match : item.value, query);
    if (value >= 0) scored.push({ item, value });
  }
  scored.sort((a, b) => b.value - a.value);
  const ranked = scored.slice(0, limit).map((entry) => entry.item);
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

function commandItems() {
  const commands = listCommands('terminal')
    .filter((command) => isTerminalSafe(command.name))
    .map((command) => ({
      value: '/' + command.name,
      match: command.name,
      label: '/' + command.name,
      description: sanitize(command.description || '')
    }));

  // Skills answer to the slash menu directly, the way claude-code surfaces a
  // skill as a command you simply type. `/docker` finds the Docker skill
  // without the user knowing it lives under `devops`, or that `/skills` exists
  // at all — which is the whole difficulty with a hundred-entry library.
  //
  // Ranked against the skill NAME first so the name is what matches, and
  // resolved to the canonical `/skills <domain>/<id>` on accept, so there is
  // still exactly one execution path and no second command namespace to collide
  // with the real commands.
  const skills = listSkillsForCompletion().map((skill) => ({
    value: `/skills ${skill.domain}/${skill.id}`,
    match: `${skill.id} ${skill.domain}`,
    label: `/${skill.id}`,
    description: sanitize(skill.description || '')
  }));

  // Commands first: on a bare `/` every entry scores 0, and a stable sort then
  // leaves the real commands above the library.
  return commands.concat(skills);
}

/**
 * A command's own argument suggestions.
 *
 * The command owns them: it knows what its argument means and this module does
 * not. Anything a command returns is treated as untrusted display text and
 * sanitised, the same as a filename.
 */
function argumentItems(name) {
  const command = listCommands('terminal')
    .find((candidate) => candidate.name === name && isTerminalSafe(candidate.name));
  if (!command || typeof command.complete !== 'function') return [];

  let produced;
  try {
    produced = command.complete();
  } catch (e) {
    return []; // a broken completer must never take the prompt down
  }
  if (!Array.isArray(produced)) return [];

  return produced
    .filter((entry) => entry && typeof entry.value === 'string' && isTerminalSafe(entry.value))
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

/**
 * A bounded, lazily built list of files under the workspace.
 *
 * openclaw shells out to `fd` and opencode uses `fff`; both are dependencies,
 * and ZM-06 rules those out. ripgrep is not a safe substitute either — Causyne
 * treats it as optional (src/tools/codeSearcher.js probes for a system binary
 * and falls back to Node), so requiring it would make completion work on some
 * machines and not others.
 *
 * So: the directory listing answers instantly and always, and this index
 * upgrades the experience once it is ready. If it is never ready, nothing
 * breaks — the caller must never await it.
 */
export class FileIndex {
  constructor(root) {
    this.root = root;
    this.entries = null;
    this.building = null;
    this.truncated = false;
  }

  get isReady() {
    return Array.isArray(this.entries);
  }

  /** Kick off the walk. Safe to call repeatedly; only the first one runs. */
  ensure() {
    if (this.entries || this.building) return this.building;
    this.building = this.walk()
      .then((entries) => { this.entries = entries; return entries; })
      .catch(() => { this.entries = []; return []; })
      .finally(() => { this.building = null; });
    return this.building;
  }

  async walk() {
    const found = [];
    const queue = [{ dir: this.root, depth: 0 }];

    while (queue.length > 0 && found.length < MAX_INDEX_ENTRIES) {
      const { dir, depth } = queue.shift();
      let listing;
      try {
        listing = await fsp.readdir(dir, { withFileTypes: true });
      } catch (e) {
        continue; // unreadable directory is not an error worth surfacing here
      }

      for (const entry of listing) {
        if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (SKIP_DIRECTORIES.has(entry.name) || depth >= MAX_INDEX_DEPTH) continue;
          queue.push({ dir: full, depth: depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue;

        const relative = path.relative(this.root, full);
        if (!isTerminalSafe(relative)) continue;
        found.push(relative);
        if (found.length >= MAX_INDEX_ENTRIES) {
          this.truncated = true;
          break;
        }
      }
    }
    return found;
  }
}

/** Instant, shell-style completion of one directory level. */
function directoryItems(root, partial) {
  const slash = partial.lastIndexOf('/');
  const dirPart = slash === -1 ? '' : partial.slice(0, slash + 1);
  const target = path.resolve(root, dirPart);

  // Never offer paths outside the workspace root, whatever the user typed.
  const relativeToRoot = path.relative(root, target);
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) return [];

  let listing;
  try {
    listing = fs.readdirSync(target, { withFileTypes: true });
  } catch (e) {
    return [];
  }

  const items = [];
  for (const entry of listing) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    const value = dirPart + entry.name + (entry.isDirectory() ? '/' : '');
    if (!isTerminalSafe(value)) continue;
    items.push({
      value,
      match: value,
      label: value,
      description: entry.isDirectory() ? 'directory' : ''
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Trigger detection
// ---------------------------------------------------------------------------

/**
 * What, if anything, should be completed at the cursor.
 *
 * `/` only counts at the very start of the input — that is what keeps a task
 * that merely mentions `/usr/local/bin` from opening a command picker, the same
 * rule parseCommand() enforces when the line is finally submitted.
 */
export function detectTrigger(text, cursor) {
  const before = text.slice(0, cursor);

  if (/^\/[a-z0-9_?-]*$/i.test(before)) {
    return { kind: 'command', start: 0, query: before.slice(1) };
  }

  // `/command <argument>` — the command's OWN suggestions.
  //
  // Completion used to stop dead at the space: `/skills d` offered nothing, so
  // the only way to reach a skill was to submit `/skills` bare and browse. With
  // a hundred of them that is a poor trade for someone who already knows the
  // name they want.
  //
  // openclaw's contract (src/tui/commands.ts): a command declares its argument
  // completions and the prompt asks it for the ones matching what has been typed
  // — `getArgumentCompletions(prefix)`. Same shape here, generic over every
  // command, so `/mcp`, `/model` and the rest can adopt it by adding one
  // function and nothing in this file changes.
  //
  // Anchored, and a single argument token only: a second word ends the
  // completion rather than trying to complete inside a sentence. opencode hides
  // its picker on exactly the same condition.
  const argument = before.match(/^\/([a-z0-9_?-]+)[ \t]+(\S*)$/i);
  if (argument) {
    return {
      kind: 'command-argument',
      command: argument[1],
      start: cursor - argument[2].length,
      query: argument[2]
    };
  }

  const mention = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (mention) {
    return {
      kind: 'file',
      start: cursor - mention[1].length - 1,
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
export function suggest(text, cursor, options = {}) {
  const trigger = detectTrigger(text, cursor);
  if (!trigger) return null;

  if (trigger.kind === 'command') {
    const items = rank(commandItems(), trigger.query);
    if (items.length === 0) return null;
    return { ...trigger, items, total: items.total };
  }

  if (trigger.kind === 'command-argument') {
    const items = rank(argumentItems(trigger.command), trigger.query, ARGUMENT_LIMIT);
    if (items.length === 0) return null;
    return { ...trigger, items, total: items.total };
  }

  const root = options.root || process.cwd();
  const index = options.index;
  if (index && !index.isReady) index.ensure();

  const pool = index && index.isReady && trigger.query.includes('/') === false && trigger.query
    ? index.entries.map((relative) => ({
        value: relative, match: relative, label: relative, description: ''
      }))
    : directoryItems(root, trigger.query);

  const items = rank(pool, trigger.query.slice(trigger.query.lastIndexOf('/') + 1));
  if (items.length === 0) return null;
  return { ...trigger, items, total: items.total };
}

/** Replace the trigger span with the chosen value. */
export function applyCompletion(text, cursor, trigger, item) {
  if (trigger.kind === 'command-argument') {
    const head = text.slice(0, trigger.start);
    const tail = text.slice(cursor);

    // A COMPLETE argument gets a trailing space; a partial one does not.
    //
    // This was written the other way round, on the theory that a space would
    // reopen the picker on a value still being edited. It does not — a
    // completed argument followed by a space matches no trigger at all. What it
    // actually did was run the user's next words straight into the argument:
    // accepting `python/data-processing-pipelines` and typing a question gave
    // `/skills python/data-processing-pipelineswhy my data is like this ?` and
    // a "skill not found" error.
    //
    // The distinction is the same one file completion already makes between a
    // directory and a file: a domain (`devops`) is a place you may want to
    // descend into with `/`, so it gets no space; a full `domain/skill` id is
    // finished, so it gets one and the next thing typed is the instruction.
    const complete = item.value.includes('/');
    const replaced = head + item.value + (complete ? ' ' : '');
    return { text: replaced + tail, cursor: replaced.length };
  }

  const value = trigger.kind === 'command' ? item.value : '@' + item.value;
  const head = text.slice(0, trigger.start);
  const tail = text.slice(cursor);
  // A directory keeps the picker useful: no trailing space, so the next
  // keystroke drills in rather than starting a new word.
  //
  // Everything else — including a skill picked from the slash menu, whose value
  // is a whole `/skills domain/id` command — gets one, so the next thing typed
  // is a new word rather than more of the last one. The exclusion that used to
  // sit here for values containing a space was the same mistake as above: it
  // made `/docker` complete to `/skills devops/docker-multi-stage-builds` with
  // nothing after it, and the user's instruction fused onto the id.
  const suffix = (trigger.kind === 'file' && item.value.endsWith('/')) ? '' : ' ';
  const replaced = head + value + suffix;
  return { text: replaced + tail, cursor: replaced.length };
}

/** Rows for the picker, already bounded and safe to print. */
export function renderPicker(items, selected, width) {
  const start = Math.max(0, Math.min(selected - MAX_VISIBLE + 1, items.length - MAX_VISIBLE));
  const window = items.slice(Math.max(0, start), Math.max(0, start) + MAX_VISIBLE);
  return window.map((item, offset) => ({
    item,
    selected: Math.max(0, start) + offset === selected,
    label: shortenHome(item.label),
    description: item.description || ''
  }));
}
