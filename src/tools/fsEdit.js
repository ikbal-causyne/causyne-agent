import fs from 'fs/promises';
import os from 'os';

// Phase 3 AGI Upgrade: Fast Levenshtein Distance for Fuzzy Matching
function getLevenshteinDistance(a, b) {
  const matrix = Array(a.length + 1).fill(null).map(() => Array(b.length + 1).fill(null));

  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1, // deletion
        matrix[i][j - 1] + 1, // insertion
        matrix[i - 1][j - 1] + indicator // substitution
      );
    }
  }
  return matrix[a.length][b.length];
}

function calculateConfidence(original, match) {
  const dist = getLevenshteinDistance(original, match);
  const maxLen = Math.max(original.length, match.length);
  if (maxLen === 0) return 100;
  return ((maxLen - dist) / maxLen) * 100;
}

export const fsEdit = {
  schema: {
    name: 'fs.edit',
    description: 'Surgically edit specific lines/blocks in a file. Employs 90% confidence Levenshtein fuzzy matching if exact match fails.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              searchContent: { type: 'string' },
              replaceContent: { type: 'string' }
            },
            required: ['searchContent', 'replaceContent']
          }
        }
      },
      required: ['path', 'edits']
    }
  },
  async execute(args) {
    try {
      const target = args.path.replace(/^~\//, os.homedir() + '/');
      let originalContent = await fs.readFile(target, 'utf8');
      let workingContent = originalContent; // Phase 3 AGI Upgrade: Atomic Rollback prep
      
      let replacements = 0;
      for (let i = 0; i < args.edits.length; i++) {
        const edit = args.edits[i];
        
        // Try exact match first
        if (workingContent.includes(edit.searchContent)) {
          workingContent = workingContent.replace(edit.searchContent, edit.replaceContent);
          replacements++;
          continue;
        }
        
        // Phase 3 AGI Upgrade: Fuzzy Match Fallback
        const lines = workingContent.split('\n');
        const oldLines = edit.searchContent.split('\n');
        let bestMatch = null;
        let highestConfidence = 0;
        
        for (let j = 0; j <= lines.length - oldLines.length; j++) {
          const chunk = lines.slice(j, j + oldLines.length).join('\n');
          const conf = calculateConfidence(edit.searchContent, chunk);
          if (conf > highestConfidence) {
            highestConfidence = conf;
            bestMatch = chunk;
          }
        }

        if (highestConfidence >= 90 && bestMatch) {
          workingContent = workingContent.replace(bestMatch, edit.replaceContent);
          replacements++;
        } else {
          // Atomic Rollback
          return { 
            success: false, 
            error: `ATOMIC ROLLBACK: Edit index ${i} failed. Exact match not found, and fuzzy match confidence was too low (${highestConfidence.toFixed(2)}% < 90%). Previous edits in this batch were rolled back.` 
          };
        }
      }
      
      // Commit the transaction
      await fs.writeFile(target, workingContent, 'utf8');
      return { success: true, output: `Transaction Success: ${replacements} replacement(s) safely applied to ${args.path}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
