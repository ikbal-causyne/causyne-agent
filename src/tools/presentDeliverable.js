/**
 * Causyne Agent — Explicit Deliverable Presentation Tool (`present`)
 *
 * Allows the agent to formally surface up to 8 verified workspace deliverable
 * files (reports, PDFs, images, HTML demos, documents, charts) with descriptions
 * for rich presentation in TUI and Skybridge Web Studio.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { isIgnoredByCausyneIgnore } from '../ignoreRules.js';
import { resolveScopedPath, resolveToolWorkspaceRoots, sanitizeToolError } from './toolPathSafety.js';
const MAX_DELIVERABLES = 8;
function classifyDeliverableKind(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.html' || ext === '.htm' || ext === '.svg')
        return 'html';
    if (ext === '.md' || ext === '.markdown' || ext === '.idoc')
        return 'markdown';
    if (ext === '.pdf')
        return 'pdf';
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'].includes(ext))
        return 'image';
    if (['.docx', '.xlsx', '.pptx', '.csv', '.txt', '.rtf'].includes(ext))
        return 'document';
    if (['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.css', '.json', '.yaml', '.yml'].includes(ext))
        return 'code';
    return 'file';
}
export const presentDeliverableTool = {
    schema: {
        name: 'present',
        description: 'Present up to 8 verified workspace deliverable files (PDFs, images, HTML previews, reports, documents) cleanly to the user with concise descriptions. Use for finished user-facing artifacts rather than routine source edits.',
        parameters: {
            type: 'object',
            properties: {
                files: {
                    type: 'array',
                    minItems: 1,
                    maxItems: MAX_DELIVERABLES,
                    items: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'Workspace-relative or scoped absolute path to an existing regular file.' },
                            description: { type: 'string', description: 'Short one-line description of what this deliverable contains.' }
                        },
                        required: ['path'],
                        additionalProperties: false
                    }
                }
            },
            required: ['files'],
            additionalProperties: false
        }
    },
    async execute(args, context = {}) {
        try {
            if (!Array.isArray(args?.files) || args.files.length === 0) {
                return { success: false, error: 'files must be a non-empty array of 1-8 workspace files.' };
            }
            if (args.files.length > MAX_DELIVERABLES) {
                return { success: false, error: `At most ${MAX_DELIVERABLES} deliverables can be presented in one call.` };
            }
            const scope = resolveToolWorkspaceRoots(context);
            const primaryRoot = scope.primaryRoot || process.cwd();
            const presented = [];
            const seen = new Set();
            for (const item of args.files) {
                if (!item || typeof item.path !== 'string' || !item.path.trim()) {
                    return { success: false, error: 'Every deliverable entry requires a non-empty path string.' };
                }
                const resolved = resolveScopedPath(item.path, context);
                if (isIgnoredByCausyneIgnore(resolved, primaryRoot, false)) {
                    return { success: false, error: `Deliverable path is blocked by .causyneignore: ${item.path}` };
                }
                const lstat = await fs.lstat(resolved);
                if (lstat.isSymbolicLink() || !lstat.isFile()) {
                    return { success: false, error: `Deliverable must be a regular workspace file: ${item.path}` };
                }
                const rel = path.relative(primaryRoot, resolved).split(path.sep).join('/');
                if (seen.has(rel))
                    continue;
                seen.add(rel);
                presented.push({
                    path: rel,
                    absolutePath: resolved,
                    name: path.basename(resolved),
                    sizeBytes: lstat.size,
                    kind: classifyDeliverableKind(resolved),
                    description: typeof item.description === 'string' ? item.description.trim().slice(0, 240) : ''
                });
            }
            const lines = presented.map((d, idx) => `${idx + 1}. ${d.path} (${d.kind}, ${d.sizeBytes} B)${d.description ? ` — ${d.description}` : ''}`);
            return {
                success: true,
                deliverables: presented,
                output: `Presented ${presented.length} deliverable(s):\n${lines.join('\n')}`
            };
        }
        catch (error) {
            return { success: false, error: sanitizeToolError(error) };
        }
    }
};
