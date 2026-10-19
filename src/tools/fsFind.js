import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// Phase 6 AGI Upgrade: Pure JS Levenshtein Distance for native fuzzy searching
function levenshteinDistance(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

function isMatch(filename, keywords, extensions, fuzzyMatch) {
  const lowerFilename = filename.toLowerCase();
  
  if (extensions && extensions.length > 0) {
    const extMatch = extensions.some(ext => lowerFilename.endsWith(ext.toLowerCase()));
    if (!extMatch) return false;
  }
  
  if (!keywords || keywords.length === 0) return true;

  for (const kw of keywords) {
    const lowerKw = kw.toLowerCase();
    if (lowerFilename.includes(lowerKw)) return true;
    
    // Fuzzy matching for typos (only applied if keyword is >= 4 chars)
    if (fuzzyMatch && lowerKw.length >= 4) {
      for (let i = 0; i <= lowerFilename.length - lowerKw.length + 1; i++) {
        const chunk = lowerFilename.substr(i, lowerKw.length + 1); 
        const distance = levenshteinDistance(chunk, lowerKw);
        const maxDistance = Math.floor(lowerKw.length / 4);
        if (distance <= maxDistance) return true;
      }
    }
  }
  return false;
}

export const fsFind = {
  schema: {
    name: 'fs.find',
    description: 'Blazing fast semantic and fuzzy file search by name. Non-blocking Async Indexer.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Root directory to start the search.' },
        keywords: { type: 'array', items: { type: 'string' } },
        extensions: { type: 'array', items: { type: 'string' } },
        fuzzyMatch: { type: 'boolean', description: 'Set to true to enable typo tolerance.' }
      }
    }
  },
  
  async execute(args) {
    try {
      const targetDir = (args.path || process.cwd()).replace(/^~\//, os.homedir() + '/');
      const keywords = args.keywords || [];
      const extensions = args.extensions || [];
      const fuzzyMatch = args.fuzzyMatch === true;
      
      const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.gradle', 'build', 'dist', '.idea', '.causyne_trash']);
      
      const matches = [];
      let scanned = 0;
      const MAX_MATCHES = 50;

      // Phase 6 AGI Upgrade: Asynchronous Non-Blocking Traversal to prevent Event Loop freezing
      async function walkAsync(dir) {
        if (matches.length >= MAX_MATCHES) return;
        
        let dirents;
        try {
          dirents = await fs.readdir(dir, { withFileTypes: true });
        } catch (err) {
          return; // Ignore permission/missing errors gracefully
        }

        const promises = [];
        for (const dirent of dirents) {
          if (matches.length >= MAX_MATCHES) break;
          
          if (dirent.isDirectory()) {
            if (!EXCLUDE_DIRS.has(dirent.name)) {
              promises.push(walkAsync(path.join(dir, dirent.name)));
            }
          } else if (dirent.isFile()) {
            scanned++;
            if (isMatch(dirent.name, keywords, extensions, fuzzyMatch)) {
              matches.push(path.join(dir, dirent.name));
            }
          }
        }
        await Promise.all(promises);
      }

      await walkAsync(targetDir);
      
      return { 
        success: true, 
        output: JSON.stringify({
          scanned_files: scanned,
          total_matches: matches.length,
          matches: matches.length > 0 ? matches : "No files matched your semantic parameters."
        }, null, 2)
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
