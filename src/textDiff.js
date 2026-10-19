// A unified diff, in pure JavaScript.
//
// The git backend gets patches from git itself. This exists so the NATIVE
// backend — the fallback for a machine with no git, or a workspace that is not
// a repository — can answer the same question. Without it, REVIEW would show
// line counts on one machine and real changes on another, which is the kind of
// inconsistency that makes a feature feel broken rather than degraded.
//
// No dependency: this is a standard LCS over lines, which is what `diff -u`
// computes. Bounded, because a checkpoint diff is a UI affordance and must
// never become the reason a request times out.

/** Above this many lines on either side, fall back to counts without a patch. */
const MAX_DIFF_LINES = 4000;

/** Context lines around each change, matching `diff -u` and git's default. */
const CONTEXT = 3;

/**
 * Longest common subsequence over two line arrays.
 *
 * Classic dynamic programming. O(n*m) in time and memory, which is why
 * MAX_DIFF_LINES exists — at the cap this is 16M cells, still well under a
 * second, and anything larger is not something a human reads in a dialog.
 */
function lcsTable(a, b) {
  const table = [];
  for (let i = 0; i <= a.length; i++) table.push(new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

/** Walk the table into a flat edit script: ' ' keep, '-' remove, '+' add. */
function editScript(a, b) {
  const table = lcsTable(a, b);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) { ops.push(['-', a[i]]); i++; }
    else { ops.push(['+', b[j]]); j++; }
  }
  while (i < a.length) ops.push(['-', a[i++]]);
  while (j < b.length) ops.push(['+', b[j++]]);
  return ops;
}

function splitLines(text) {
  if (text === '') return [];
  return text.replace(/\n$/, '').split('\n');
}

/**
 * A unified diff of `before` → `after`.
 *
 * @returns {{patch: string, additions: number, deletions: number, truncated: boolean}}
 */
export function unifiedDiff(before, after, pathLabel = 'file') {
  const a = splitLines(before);
  const b = splitLines(after);

  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    // Counting without the table keeps a huge file cheap: the exact per-line
    // patch is not worth an O(n*m) allocation nobody will read.
    return {
      patch: '',
      additions: b.length,
      deletions: a.length,
      truncated: true
    };
  }

  const ops = editScript(a, b);
  let additions = 0;
  let deletions = 0;
  for (const [kind] of ops) {
    if (kind === '+') additions++;
    else if (kind === '-') deletions++;
  }
  if (additions === 0 && deletions === 0) {
    return { patch: '', additions: 0, deletions: 0, truncated: false };
  }

  // Group changes into hunks with CONTEXT lines of surrounding text, so the
  // output is readable rather than the whole file with markers.
  const lines = [`--- a/${pathLabel}`, `+++ b/${pathLabel}`];
  let index = 0;
  let oldLine = 1;
  let newLine = 1;

  while (index < ops.length) {
    if (ops[index][0] === ' ') {
      if (ops[index][0] === ' ') { oldLine++; newLine++; }
      index++;
      continue;
    }

    // Walk back for leading context, then forward to the end of the change.
    const start = Math.max(0, index - CONTEXT);
    let end = index;
    let quiet = 0;
    while (end < ops.length && quiet <= CONTEXT * 2) {
      quiet = ops[end][0] === ' ' ? quiet + 1 : 0;
      end++;
    }
    end = Math.min(ops.length, end);

    let oldStart = oldLine;
    let newStart = newLine;
    for (let k = start; k < index; k++) {
      if (ops[k][0] !== '+') oldStart--;
      if (ops[k][0] !== '-') newStart--;
    }

    let oldCount = 0;
    let newCount = 0;
    const body = [];
    for (let k = start; k < end; k++) {
      const [kind, text] = ops[k];
      if (kind !== '+') oldCount++;
      if (kind !== '-') newCount++;
      body.push(`${kind}${text}`);
    }

    lines.push(`@@ -${Math.max(1, oldStart)},${oldCount} +${Math.max(1, newStart)},${newCount} @@`);
    lines.push(...body);

    for (let k = index; k < end; k++) {
      if (ops[k][0] !== '+') oldLine++;
      if (ops[k][0] !== '-') newLine++;
    }
    index = end;
  }

  return { patch: lines.join('\n'), additions, deletions, truncated: false };
}

/** Binary content has no useful line diff — detected the way git detects it. */
export function looksBinary(buffer) {
  if (!buffer || buffer.length === 0) return false;
  const sample = buffer.subarray(0, Math.min(8000, buffer.length));
  return sample.includes(0);
}
