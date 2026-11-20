import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFileSync } from '../infra/atomicWriter.js';
const MAX_FUZZY_CHARS = 8_192;
function getLevenshteinDistance(a, b) {
    let s1 = a;
    let s2 = b;
    if (s1.length > s2.length) {
        const tmp = s1;
        s1 = s2;
        s2 = tmp;
    }
    const m = s1.length;
    const n = s2.length;
    if (m === 0)
        return n;
    let prev = new Int32Array(m + 1);
    let curr = new Int32Array(m + 1);
    for (let j = 0; j <= m; j++)
        prev[j] = j;
    for (let i = 1; i <= n; i++) {
        curr[0] = i;
        const ch2 = s2.charCodeAt(i - 1);
        for (let j = 1; j <= m; j++) {
            const cost = s1.charCodeAt(j - 1) === ch2 ? 0 : 1;
            const del = prev[j] + 1;
            const ins = curr[j - 1] + 1;
            const sub = prev[j - 1] + cost;
            curr[j] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
        }
        const swap = prev;
        prev = curr;
        curr = swap;
    }
    return prev[m];
}
function calculateConfidence(original, match) {
    const maxLen = Math.max(original.length, match.length);
    if (maxLen === 0)
        return 100;
    if (maxLen > MAX_FUZZY_CHARS)
        return 0;
    // Impossible to reach 90% confidence when length difference alone exceeds 10%
    if (Math.abs(original.length - match.length) / maxLen > 0.1)
        return 0;
    const dist = getLevenshteinDistance(original, match);
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
            if (!args || typeof args !== 'object') {
                return { success: false, error: 'fs_edit requires an object with path and edits array.' };
            }
            if (typeof args.path !== 'string' || !args.path.trim()) {
                return { success: false, error: 'fs_edit requires a non-empty string path.' };
            }
            if (!Array.isArray(args.edits) || args.edits.length === 0) {
                return { success: false, error: 'fs_edit requires a non-empty edits array.' };
            }
            const targetPath = args.path.trim();
            const target = targetPath.startsWith('~/') || targetPath.startsWith('~\\')
                ? path.join(os.homedir(), targetPath.slice(2))
                : path.resolve(targetPath);
            const originalContent = await fs.readFile(target, 'utf8');
            let workingContent = originalContent;
            let replacements = 0;
            for (let i = 0; i < args.edits.length; i++) {
                const edit = args.edits[i];
                if (!edit || typeof edit.searchContent !== 'string' || edit.searchContent.length === 0 || typeof edit.replaceContent !== 'string') {
                    return {
                        success: false,
                        error: `ATOMIC ROLLBACK: Edit index ${i} is missing valid non-empty searchContent or replaceContent strings. Rollback complete.`
                    };
                }
                // Try exact match first
                if (workingContent.includes(edit.searchContent)) {
                    workingContent = workingContent.replace(edit.searchContent, () => edit.replaceContent);
                    replacements++;
                    continue;
                }
                // Fuzzy Match Fallback
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
                    workingContent = workingContent.replace(bestMatch, () => edit.replaceContent);
                    replacements++;
                }
                else {
                    return {
                        success: false,
                        error: `ATOMIC ROLLBACK: Edit index ${i} failed. Exact match not found, and fuzzy match confidence was too low (${highestConfidence.toFixed(2)}% < 90%). Previous edits in this batch were rolled back.`
                    };
                }
            }
            // Commit the transaction atomically
            atomicWriteFileSync(target, workingContent, { encoding: 'utf8' });
            return { success: true, output: `Transaction Success: ${replacements} replacement(s) safely applied to ${args.path}` };
        }
        catch (e) {
            return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
    }
};
