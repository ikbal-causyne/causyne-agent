/**
 * Causyne Agent — Ranked Repository Map Tool (`code.repo_map`)
 */
import { buildRepoMap } from '../codebase/repoMap.js';
import { boundedInteger, resolveToolWorkspaceRoots, sanitizeToolError } from './toolPathSafety.js';
export const repoMapTool = {
    schema: {
        name: 'code.repo_map',
        description: 'Build a token-budgeted, PageRank-ranked architectural map of the workspace showing the highest-centrality files and exported symbols across TypeScript, JavaScript, Python, Go, Rust, and C/C++.',
        parameters: {
            type: 'object',
            properties: {
                maxChars: {
                    type: 'integer',
                    description: 'Maximum output size in characters (default 6000, max 48000).'
                },
                maxFiles: {
                    type: 'integer',
                    description: 'Maximum source files to scan (default 400, max 1500).'
                },
                focusFiles: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional workspace-relative file paths to boost in ranking.'
                }
            }
        }
    },
    async execute(args = {}, context = {}) {
        try {
            const safeArgs = args && typeof args === 'object' ? args : {};
            const scope = resolveToolWorkspaceRoots(context);
            const workspaceRoot = scope.primaryRoot || process.cwd();
            const maxChars = boundedInteger(safeArgs.maxChars, 6000, 400, 48_000);
            const maxFiles = boundedInteger(safeArgs.maxFiles, 400, 10, 1500);
            const focusFiles = Array.isArray(safeArgs.focusFiles)
                ? safeArgs.focusFiles.filter((f) => typeof f === 'string' && f.trim().length > 0).slice(0, 20)
                : undefined;
            const map = buildRepoMap(workspaceRoot, { maxChars, maxFiles, focusFiles });
            return { success: true, output: map.rendered };
        }
        catch (err) {
            return { success: false, error: sanitizeToolError(err) };
        }
    }
};
