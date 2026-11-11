import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFileSync } from '../infra/atomicWriter.js';

export interface MultiEditItem {
  old_string: string;
  new_string: string;
}

export interface MultiEditArgs {
  file_path: string;
  edits: MultiEditItem[];
}

export interface MultiEditResult {
  success: boolean;
  output?: string;
  error?: string;
}

function getLevenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = Array(a.length + 1)
    .fill(null)
    .map(() => Array(b.length + 1).fill(0));

  for (let i = 0; i <= a.length; i++) matrix[i]![0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0]![j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1, // deletion
        matrix[i]![j - 1]! + 1, // insertion
        matrix[i - 1]![j - 1]! + indicator // substitution
      );
    }
  }
  return matrix[a.length]![b.length]!;
}

function calculateConfidence(original: string, match: string): number {
  const dist = getLevenshteinDistance(original, match);
  const maxLen = Math.max(original.length, match.length);
  if (maxLen === 0) return 100;
  return ((maxLen - dist) / maxLen) * 100;
}

export const multiEdit = {
  schema: {
    name: 'MultiEdit',
    description: 'Make multiple edits to a single file atomically. Replaces old_string with new_string. If exact match fails, uses fuzzy matching (requires 90% confidence). Includes atomic rollback.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string' },
              new_string: { type: 'string' }
            },
            required: ['old_string', 'new_string']
          },
          minItems: 1
        }
      },
      required: ['file_path', 'edits']
    }
  },

  async execute(args: MultiEditArgs): Promise<MultiEditResult> {
    try {
      if (!args || typeof args !== 'object') {
        return { success: false, error: 'MultiEdit requires an object with file_path and edits array.' };
      }
      if (typeof args.file_path !== 'string' || !args.file_path.trim()) {
        return { success: false, error: 'MultiEdit requires a non-empty string file_path.' };
      }
      if (!Array.isArray(args.edits) || args.edits.length === 0) {
        return { success: false, error: 'MultiEdit requires a non-empty edits array.' };
      }

      const rawPath = args.file_path.trim();
      const target = rawPath.startsWith('~/') || rawPath.startsWith('~\\')
        ? path.join(os.homedir(), rawPath.slice(2))
        : path.resolve(rawPath);

      const originalContent = await fs.readFile(target, 'utf8');
      let workingContent = originalContent;
      let replacements = 0;

      for (let i = 0; i < args.edits.length; i++) {
        const edit = args.edits[i];
        if (!edit || typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string') {
          return {
            success: false,
            error: `ATOMIC ROLLBACK: Edit index ${i} is missing valid old_string or new_string. Rollback complete.`
          };
        }

        // Try exact match first
        if (workingContent.includes(edit.old_string)) {
          workingContent = workingContent.replace(edit.old_string, edit.new_string);
          replacements++;
          continue;
        }

        // Fuzzy Match Fallback
        const lines = workingContent.split('\n');
        const oldLines = edit.old_string.split('\n');
        let bestMatch: string | null = null;
        let highestConfidence = 0;

        for (let j = 0; j <= lines.length - oldLines.length; j++) {
          const chunk = lines.slice(j, j + oldLines.length).join('\n');
          const conf = calculateConfidence(edit.old_string, chunk);
          if (conf > highestConfidence) {
            highestConfidence = conf;
            bestMatch = chunk;
          }
        }

        if (highestConfidence >= 90 && bestMatch) {
          workingContent = workingContent.replace(bestMatch, edit.new_string);
          replacements++;
        } else {
          return {
            success: false,
            error: `ATOMIC ROLLBACK: Edit index ${i} failed. Exact match not found, and fuzzy match confidence was too low (${highestConfidence.toFixed(2)}% < 90%). Previous edits in this batch were rolled back.`
          };
        }
      }

      // Commit the transaction atomically
      atomicWriteFileSync(target, workingContent, { encoding: 'utf8' });
      return { success: true, output: `Transaction Success: ${replacements} atomic edits applied to ${args.file_path}` };
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
};
