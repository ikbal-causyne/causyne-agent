// Structural diff for the approval prompt.
//
// The approval gate used to show the user a tool name and a path:
//
//   [ DANGEROUS ] fs_edit   edit
//     site/index.html (3 edits)
//
// and then asked "Approve?". That is a procedural gate, not a real one — the
// human is consenting to a file mutation whose content they have never seen.
// sandbox.js classifies the risk correctly and makeApprovalHandler asks the
// question correctly; the missing half was always the payload.
//
// This module answers "what will actually change" for the four tools that
// mutate a file, and it does so under three hard bounds, because the input is
// attacker-influenced:
//
//  1. The diff is computed over at most MAX_SIDE_LINES rows per side. LCS is
//     O(n*m); an unbounded model-supplied payload is a way to hang the terminal
//     at exactly the moment the user is being asked to consent.
//  2. At most MAX_RENDER_LINES rows reach the screen, so a large rewrite cannot
//     scroll the question itself out of the scrollback.
//  3. Every content row passes through text.safeDisplay(), because file content
//     can carry escapes — and a cursor-moving escape printed one row above an
//     approval prompt can repaint the prompt.
//
// Pure Node over ./theme.js and ./text.js. No dependency, no shell.

import fs from 'fs';
import { paint, dim, GLYPHS } from './theme.js';
import { truncate, safeDisplay, shortenHome } from './text.js';

// Per side, for the LCS table. 600x600 int cells is ~1.4 MB and a few ms.
const MAX_SIDE_LINES = 600;

// Rows that reach the terminal. Deliberately smaller than a screen so the
// approval question stays visible under the diff.
const MAX_RENDER_LINES = 40;

// Unchanged rows kept either side of a change, so an edit has context.
const CONTEXT = 2;

// A file larger than this is not read to build a diff. At that size the diff is
// not readable anyway, and the read is on the interactive path.
const MAX_FILE_BYTES = 512 * 1024;

/** Split into lines without inventing a trailing empty row for a final \n. */
function splitLines(text) {
  const normalised = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  if (normalised === '') return [];
  const lines = normalised.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Line diff by longest common subsequence.
 *
 * Returns ops in source order: { kind: 'ctx' | 'del' | 'add', text }.
 *
 * A word-level or Myers diff would produce prettier output, but this runs while
 * a human is waiting to answer a security question. Correct and bounded beats
 * minimal.
 */
export function diffLines(before, after) {
  const a = splitLines(before);
  const b = splitLines(after);

  // Bound BEFORE building the table, not after.
  const truncated = a.length > MAX_SIDE_LINES || b.length > MAX_SIDE_LINES;
  const left = truncated ? a.slice(0, MAX_SIDE_LINES) : a;
  const right = truncated ? b.slice(0, MAX_SIDE_LINES) : b;

  const rows = left.length;
  const cols = right.length;

  // lengths[i][j] = LCS length of left[i..] and right[j..], flattened.
  const width = cols + 1;
  const lengths = new Int32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      lengths[i * width + j] = left[i] === right[j]
        ? lengths[(i + 1) * width + (j + 1)] + 1
        : Math.max(lengths[(i + 1) * width + j], lengths[i * width + (j + 1)]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (left[i] === right[j]) {
      ops.push({ kind: 'ctx', text: left[i] });
      i++; j++;
    } else if (lengths[(i + 1) * width + j] >= lengths[i * width + (j + 1)]) {
      ops.push({ kind: 'del', text: left[i] });
      i++;
    } else {
      ops.push({ kind: 'add', text: right[j] });
      j++;
    }
  }
  while (i < rows) ops.push({ kind: 'del', text: left[i++] });
  while (j < cols) ops.push({ kind: 'add', text: right[j++] });

  return { ops, truncated };
}

/** Added/removed counts, for the one-line summary. */
export function diffStat(ops) {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === 'add') added++;
    else if (op.kind === 'del') removed++;
  }
  return { added, removed };
}

/**
 * Keep only the changed rows plus CONTEXT unchanged rows either side.
 *
 * Without this, editing line 900 of a 1000-line file prints 1000 rows to show
 * one change — which is how a diff scrolls the approval question off screen.
 */
function collapse(ops) {
  const keep = new Array(ops.length).fill(false);
  for (let index = 0; index < ops.length; index++) {
    if (ops[index].kind === 'ctx') continue;
    const from = Math.max(0, index - CONTEXT);
    const to = Math.min(ops.length - 1, index + CONTEXT);
    for (let k = from; k <= to; k++) keep[k] = true;
  }

  const out = [];
  let skipping = 0;
  for (let index = 0; index < ops.length; index++) {
    if (keep[index]) {
      if (skipping > 0) {
        out.push({ kind: 'gap', count: skipping });
        skipping = 0;
      }
      out.push(ops[index]);
    } else {
      skipping++;
    }
  }
  // A trailing run of unchanged rows needs no marker — nothing follows it.
  return out;
}

/**
 * Render ops as terminal rows.
 *
 * Colour comes from the semantic roles, so this degrades with NO_COLOR and on a
 * light background exactly like the rest of the TUI. The +/- markers carry the
 * meaning on their own, which is what makes the no-colour output still readable.
 */
export function renderDiffOps(ops, options = {}) {
  const width = Math.max(20, (options.width || 80) - 8);
  const maxLines = options.maxLines || MAX_RENDER_LINES;
  const collapsed = collapse(ops);
  const rendered = [];

  for (const op of collapsed) {
    if (rendered.length >= maxLines) break;

    if (op.kind === 'gap') {
      rendered.push(dim(`     ${GLYPHS.ellipsis} ${op.count} unchanged line${op.count === 1 ? '' : 's'}`));
      continue;
    }

    // Untrusted content: a file can carry escapes, and a credential the model
    // echoed back into an edit must not be printed.
    const body = truncate(safeDisplay(op.text), width, GLYPHS.ellipsis);

    if (op.kind === 'add') rendered.push(`     ${paint('success', '+')} ${paint('success', body)}`);
    else if (op.kind === 'del') rendered.push(`     ${paint('danger', '-')} ${paint('danger', body)}`);
    else rendered.push(`     ${dim(' ')} ${dim(body)}`);
  }

  const clipped = collapsed.length > rendered.length;
  return { rows: rendered, clipped };
}

/** Convenience: two texts straight to rows. */
export function renderDiff(before, after, options = {}) {
  const { ops, truncated } = diffLines(before, after);
  const { rows, clipped } = renderDiffOps(ops, options);
  return { rows, stat: diffStat(ops), clipped: clipped || truncated };
}

/** Read a file for diffing, or null when that is not sensible. */
function readForDiff(pathish) {
  if (!pathish) return null;
  try {
    const target = String(pathish).replace(/^~(?=\/|\\|$)/, process.env.HOME || '~');
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(target, 'utf8');
  } catch (e) {
    // Missing file is the normal case for a create; anything else (permission,
    // a directory, a binary) simply means no diff, never a broken transcript.
    return null;
  }
}

function firstString(args, keys) {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

/**
 * Concatenate the search/replace sides of an edit list into two texts.
 *
 * Diffing each edit separately would be more precise, but an edit list is
 * applied as one atomic mutation and the user is answering one question about
 * it. One diff, in edit order, matches what they are consenting to.
 */
function editSides(edits) {
  const before = [];
  const after = [];
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object') continue;
    const from = firstString(edit, ['searchContent', 'old_string', 'oldText', 'search']);
    const to = firstString(edit, ['replaceContent', 'new_string', 'newText', 'replace']);
    if (from) before.push(from);
    if (to) after.push(to);
  }
  return { before: before.join('\n'), after: after.join('\n') };
}


const DIFF_BUILDERS = new Map([
  ['fs_write', (args) => {
    const path = firstString(args, ['path', 'file_path']);
    const content = typeof args.content === 'string' ? args.content : '';
    const existing = readForDiff(path);
    return {
      path,
      before: existing === null ? '' : existing,
      after: content,
      note: existing === null ? 'new file' : ''
    };
  }],
  ['fs_edit', (args) => {
    const sides = editSides(Array.isArray(args.edits) ? args.edits : []);
    return { path: firstString(args, ['path', 'file_path']), before: sides.before, after: sides.after, note: '' };
  }],
  ['MultiEdit', (args) => {
    const sides = editSides(Array.isArray(args.edits) ? args.edits : []);
    return { path: firstString(args, ['file_path', 'path']), before: sides.before, after: sides.after, note: '' };
  }],
  ['fs_delete', (args) => {
    const path = firstString(args, ['path', 'file_path']);
    const existing = readForDiff(path);
    if (existing === null) return null;
    return { path, before: existing, after: '', note: 'entire file' };
  }]
]);

/**
 * The diff block for one approval, or null when the tool does not mutate a file.
 *
 * Never throws: a rendering failure here must not be able to suppress the
 * approval question itself.
 */
export function approvalDiff(toolName, args, options = {}) {
  try {
    const builder = DIFF_BUILDERS.get(toolName);
    if (!builder) return null;

    const safeArgs = args && typeof args === 'object' ? args : {};
    const plan = builder(safeArgs);
    if (!plan) return null;
    if (plan.before === plan.after) return null;

    const { rows, stat, clipped } = renderDiff(plan.before, plan.after, options);
    if (rows.length === 0) return null;

    return {
      path: plan.path ? shortenHome(plan.path) : '',
      note: plan.note,
      rows,
      added: stat.added,
      removed: stat.removed,
      clipped
    };
  } catch (e) {
    return null;
  }
}

export { MAX_SIDE_LINES, MAX_RENDER_LINES, CONTEXT };
