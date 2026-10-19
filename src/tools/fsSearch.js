import fs from 'fs/promises';
import path from 'path';

// Text search across a directory tree.
//
// The previous implementation had four problems that only show up on a real
// repository (finding D-13):
//
//   1. It recursed without tracking realpaths, so a symlink pointing at an
//      ancestor sent it round forever.
//   2. It read every candidate file whole into memory with no size cap — one

//   3. It decided "binary" from a fixed list of nine extensions, so `.woff2`,
//      `.mp4`, `.class`, `.pdf` and every unknown format were parsed as text.
//   4. It excluded exactly five directory names, ignoring `.gitignore`, so it
//      spent most of its time inside build output the user never wanted.
//
// And when it found nothing it said "No matches found. (Semantic Search module
// pending activation)" — advertising a module that was two comment lines. That
// sentence is gone: the tool now reports only what it actually did.

const DEFAULT_EXCLUDES = [
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target',
  '.gradle', '.idea', '.vscode', '.next', '.nuxt', '.cache', '__pycache__',
  'venv', '.venv', 'vendor', 'Pods', 'DerivedData', 'coverage', '.terraform'
];

// Above this, a file is treated as data rather than source. Large minified
// bundles and lockfiles are the common case and are rarely what a search is for.
const MAX_FILE_BYTES = 2 * 1024 * 1024;

// A NUL byte in the first block is the standard binary heuristic — the same one
// grep uses. It is content-based, so it works for formats nobody listed.
const SNIFF_BYTES = 8192;

const DEFAULT_MAX_RESULTS = 100;

/** Turn a .gitignore into a matcher. Deliberately simple: names and globs. */
async function loadIgnorePatterns(root) {
  const patterns = [];
  try {
    const raw = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
      patterns.push(trimmed.replace(/^\/+|\/+$/g, ''));
    }
  } catch (e) { /* no .gitignore is the normal case outside a repo */ }
  return patterns;
}

function isIgnored(name, patterns) {
  for (const pattern of patterns) {
    if (pattern === name) return true;
    // Only the two glob shapes that actually appear in most .gitignore files.
    if (pattern.startsWith('*') && name.endsWith(pattern.slice(1))) return true;
    if (pattern.endsWith('*') && name.startsWith(pattern.slice(0, -1))) return true;
  }
  return false;
}

/**
 * Walk a tree, yielding file paths.
 *
 * `seen` holds the realpath of every directory already entered, which is what
 * stops a symlink cycle: `a/link -> ..` resolves to a directory already in the
 * set and is skipped rather than followed forever.
 */
async function* walk(dir, excludes, ignorePatterns, seen) {
  let real;
  try {
    real = await fs.realpath(dir);
  } catch (e) {
    return;
  }
  if (seen.has(real)) return;
  seen.add(real);

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return; // unreadable directory: skip it, do not fail the whole search
  }

  for (const entry of entries) {
    if (excludes.includes(entry.name) || isIgnored(entry.name, ignorePatterns)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full, excludes, ignorePatterns, seen);
    } else if (entry.isFile()) {
      yield full;
    } else if (entry.isSymbolicLink()) {
      // Resolve once and classify; the `seen` set handles a directory cycle.
      try {
        const stat = await fs.stat(full);
        if (stat.isDirectory()) yield* walk(full, excludes, ignorePatterns, seen);
        else if (stat.isFile()) yield full;
      } catch (e) { /* broken link */ }
    }
  }
}

/** True when the first block contains a NUL byte. */
async function looksBinary(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } catch (e) {
    return true; // unreadable: treat as not searchable
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

export const fsSearch = {
  schema: {
    name: 'fs.search',
    description: 'Search for text across files in a directory tree. Skips ignored and build directories, binary files, and files larger than 2 MB.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text or regular expression to find.' },
        path: { type: 'string', description: 'Directory to search in. Defaults to the working directory.' },
        isRegex: { type: 'boolean', description: 'Treat the query as a regular expression.' },
        maxResults: { type: 'integer', description: `Stop after this many matching lines. Defaults to ${DEFAULT_MAX_RESULTS}.` }
      },
      required: ['query']
    }
  },

  async execute(args) {
    try {
      const searchPath = args.path || process.cwd();
      const maxResults = Number.isInteger(args.maxResults) && args.maxResults > 0
        ? Math.min(args.maxResults, 1000)
        : DEFAULT_MAX_RESULTS;

      let regex;
      try {
        regex = args.isRegex
          ? new RegExp(args.query)
          : new RegExp(args.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      } catch (e) {
        return { success: false, error: 'Invalid regular expression: ' + e.message };
      }

      const ignorePatterns = await loadIgnorePatterns(searchPath);
      const results = [];
      let filesScanned = 0;
      let filesSkipped = 0;
      let truncated = false;

      for await (const file of walk(searchPath, DEFAULT_EXCLUDES, ignorePatterns, new Set())) {
        if (results.length >= maxResults) { truncated = true; break; }

        let stat;
        try {
          stat = await fs.stat(file);
        } catch (e) { continue; }
        if (stat.size > MAX_FILE_BYTES) { filesSkipped++; continue; }
        if (await looksBinary(file)) { filesSkipped++; continue; }

        let content;
        try {
          content = await fs.readFile(file, 'utf8');
        } catch (e) { continue; }
        filesScanned++;

        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!regex.test(lines[i])) continue;
          results.push(`${file}:${i + 1}:${lines[i].trim().slice(0, 300)}`);
          if (results.length >= maxResults) { truncated = true; break; }
        }
      }

      if (results.length === 0) {
        return {
          success: true,
          output: `No matches found. Scanned ${filesScanned} files under ${searchPath}` +
                  (filesSkipped > 0 ? `; skipped ${filesSkipped} binary or oversized files.` : '.')
        };
      }

      return {
        success: true,
        output: results.join('\n') +
                (truncated ? `\n\n[stopped at ${maxResults} matches — narrow the query or raise maxResults]` : '')
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
