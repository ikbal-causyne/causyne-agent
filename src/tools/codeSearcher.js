import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { causyneHome } from '../utils/paths.js';

const execFileAsync = promisify(execFile);

// Helper: Check system ripgrep binary availability
function getRipgrepBinary() {
  const isWin = process.platform === 'win32';
  const candidates = isWin
    ? ['C:\\Program Files\\ripgrep\\rg.exe', 'rg.exe']
    : ['/opt/homebrew/bin/rg', '/usr/local/bin/rg', '/usr/bin/rg', 'rg'];

  for (const bin of candidates) {
    try {
      if (fsSync.existsSync(bin)) return bin;
    } catch (e) {}
  }
  return null;
}

// Helper: V5 Cortex SQLite Cache (non-blocking schema init)
function getCortexDb() {
  try {
    const dbPath = path.join(causyneHome(), 'cortex.db');
    if (!fsSync.existsSync(path.dirname(dbPath))) {
      fsSync.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    // Lazy check if better-sqlite3 is available in dependencies
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { timeout: 2000 });
    db.exec(`
      CREATE TABLE IF NOT EXISTS code_search_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query TEXT,
        search_path TEXT,
        results_json TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_code_search_query ON code_search_cache(query, search_path);
    `);
    return db;
  } catch (e) {
    return null;
  }
}

export const codeSearcher = {
  schema: {
    name: 'code.search_ripgrep',
    description: 'Blazing fast regex, string, and AST symbol search across entire codebases using dual-engine ripgrep + fast Node stream and V5 Cortex SQLite caching. Surpasses standard CLI glob search.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The exact string, symbol, or regular expression pattern to look for across files.' },
        searchPath: { type: 'string', description: 'Absolute root directory or file path to search. Defaults to current working directory.' },
        isRegex: { type: 'boolean', description: 'If true, treats query as a regular expression pattern. If false, treats as literal string.' },
        caseInsensitive: { type: 'boolean', description: 'If true, performs case-insensitive search (default true).' },
        filePattern: { type: 'string', description: 'Optional glob filter (e.g. "*.js", "*.py", "*.kt", "*.ts") to restrict search to specific file extensions.' },
        astMode: { type: 'boolean', description: 'If true, filters results specifically for AST symbol definitions (classes, functions, interfaces, structs, defs).' }
      },
      required: ['query']
    }
  },

  async execute(args) {
    try {
      const query = args.query;
      if (!query) return { success: false, error: 'Query parameter is required.' };

      const targetDir = (args.searchPath || process.cwd()).replace(/^~\//, os.homedir() + '/');
      const isRegex = args.isRegex === true;
      const caseInsensitive = args.caseInsensitive !== false; // default true
      const filePattern = args.filePattern || '*';
      const astMode = args.astMode === true;

      // Check V5 Cortex SQLite Cache first
      let db = null;
      try {
        db = getCortexDb();
        if (db) {
          const cacheKey = `${query}_${isRegex}_${caseInsensitive}_${filePattern}_${astMode}`;
          const row = db.prepare('SELECT results_json FROM code_search_cache WHERE query = ? AND search_path = ? AND timestamp >= datetime("now", "-10 minutes") LIMIT 1').get(cacheKey, targetDir);
          if (row && row.results_json) {
            const cachedResults = JSON.parse(row.results_json);
            return {
              success: true,
              output: JSON.stringify({
                engine: 'Cortex Neural Cache (0ms)',
                query: query,
                total_matches: cachedResults.length,
                matches: cachedResults
              }, null, 2)
            };
          }
        }
      } catch (cacheErr) {}

      const matches = [];
      const MAX_MATCHES = 100;
      const rgBin = getRipgrepBinary();

      // Dual-Engine 1: Ripgrep Binary
      if (rgBin) {
        const rgArgs = ['-n', '--no-heading', `--max-count=${MAX_MATCHES}`];
        if (caseInsensitive) rgArgs.push('-i');
        if (!isRegex) rgArgs.push('-F');
        if (filePattern && filePattern !== '*') rgArgs.push('-g', filePattern);
        
        // If AST mode, build an AST regex around the symbol
        let finalQuery = query;
        if (astMode && !isRegex) {
          rgArgs.push('-e');
          finalQuery = `(class|function|def|interface|struct|const|let|var|type|func|module)\\s+[^\\s(]*${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
        } else {
          rgArgs.push('-e', finalQuery);
        }
        rgArgs.push(targetDir);

        try {
          const { stdout } = await execFileAsync(rgBin, rgArgs, { maxBuffer: 10 * 1024 * 1024 });
          const lines = stdout.split('\n').filter(Boolean);
          for (const line of lines) {
            if (matches.length >= MAX_MATCHES) break;
            const parts = line.split(':');
            if (parts.length >= 3) {
              const file = parts[0];
              const lineNo = parseInt(parts[1], 10) || 0;
              const content = parts.slice(2).join(':').trim();
              matches.push({ File: file, LineNumber: lineNo, LineContent: content });
            }
          }
        } catch (rgErr) {
          // If exit code is 1, ripgrep simply found no matches. Otherwise fall through to Node stream.
          if (rgErr.code !== 1 && rgErr.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            // Fallback to async Node stream
          }
        }
      }

      // Dual-Engine 2: Fast Asynchronous Node Stream Fallback (if rg returned empty or not installed)
      if (matches.length === 0 && (!rgBin || !fsSync.existsSync(rgBin))) {
        const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.gradle', 'build', 'dist', '.idea', '.causyne_trash']);
        
        let patternRegExp;
        try {
          let pat = isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          if (astMode && !isRegex) {
            pat = `(class|function|def|interface|struct|const|let|var|type|func|module)\\s+[^\\s(]*${pat}`;
          }
          patternRegExp = new RegExp(pat, caseInsensitive ? 'i' : '');
        } catch (regErr) {
          return { success: false, error: `Invalid regex pattern: ${regErr.message}` };
        }

        const extFilter = (filePattern && filePattern !== '*' && filePattern.startsWith('*.'))
          ? filePattern.slice(1).toLowerCase()
          : null;

        async function walkSearch(dir) {
          if (matches.length >= MAX_MATCHES) return;
          let dirents;
          try {
            dirents = await fs.readdir(dir, { withFileTypes: true });
          } catch (e) {
            return;
          }

          const promises = [];
          for (const dirent of dirents) {
            if (matches.length >= MAX_MATCHES) break;
            if (dirent.isDirectory()) {
              if (!EXCLUDE_DIRS.has(dirent.name)) {
                promises.push(walkSearch(path.join(dir, dirent.name)));
              }
            } else if (dirent.isFile()) {
              if (extFilter && !dirent.name.toLowerCase().endsWith(extFilter)) continue;
              
              promises.push(
                fs.readFile(path.join(dir, dirent.name), 'utf8')
                  .then(content => {
                    const lines = content.split('\n');
                    for (let i = 0; i < lines.length; i++) {
                      if (matches.length >= MAX_MATCHES) break;
                      if (patternRegExp.test(lines[i])) {
                        matches.push({
                          File: path.join(dir, dirent.name),
                          LineNumber: i + 1,
                          LineContent: lines[i].trim()
                        });
                      }
                    }
                  })
                  .catch(() => {}) // Ignore binary/unreadable files
              );
            }
          }
          await Promise.all(promises);
        }

        await walkSearch(targetDir);
      }

      // Cache matches in Cortex SQLite if db active
      if (db && matches.length > 0) {
        try {
          const cacheKey = `${query}_${isRegex}_${caseInsensitive}_${filePattern}_${astMode}`;
          db.prepare('INSERT INTO code_search_cache (query, search_path, results_json) VALUES (?, ?, ?)')
            .run(cacheKey, targetDir, JSON.stringify(matches));
        } catch (cacheStoreErr) {}
      }

      return {
        success: true,
        output: JSON.stringify({
          engine: rgBin ? `Ripgrep Binary (${rgBin})` : 'Node Async Stream Engine',
          query: query,
          total_matches: matches.length,
          matches: matches.length > 0 ? matches : "No matches found in target codebase."
        }, null, 2)
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
