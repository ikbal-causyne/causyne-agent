/*
 * Copyright (c) 2011-2024 Thesys Inc.
 * SPDX-License-Identifier: MIT
 *
 * Causyne UI Forge Tool Wrapper.
 */
import fs from 'node:fs';
import path from 'node:path';
import { generateHtmlComponent, generatePreviewHtml, generateReactComponent } from '../uiEngine/uiForge.js';
import { resolveUserPath } from '../utils/paths.js';
function canonicalUiPath(target) {
    const resolved = path.resolve(target);
    try {
        return fs.realpathSync(resolved);
    }
    catch {
        let current = resolved;
        const missing = [];
        for (let i = 0; i < 64; i++) {
            const parent = path.dirname(current);
            if (parent === current)
                break;
            missing.unshift(path.basename(current));
            current = parent;
            try {
                return path.join(fs.realpathSync(current), ...missing);
            }
            catch {
                continue;
            }
        }
        return resolved;
    }
}
function assertUiWriteScope(target, context) {
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
        throw new Error(`Refusing to overwrite symbolic link: ${target}`);
    }
    if (!context || context.grantAllAccess === true)
        return;
    const configured = Array.isArray(context.workspacePaths)
        ? context.workspacePaths.filter((p) => typeof p === 'string' && p.trim().length > 0).map(p => p.trim())
        : [];
    const roots = configured.length > 0
        ? configured
        : [context.parentLoop?.workspaceRoot, context.workspaceRoot]
            .filter((p) => typeof p === 'string' && p.trim().length > 0)
            .map(p => p.trim());
    if (roots.length === 0)
        return;
    const physical = canonicalUiPath(target);
    for (const root of roots) {
        try {
            const realRoot = fs.realpathSync(resolveUserPath(root));
            const rel = path.relative(realRoot, physical);
            if (rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)))
                return;
        }
        catch {
            continue;
        }
    }
    throw new Error(`UI output path resolves outside the selected workspace: ${target}`);
}
export const uiForge = {
    schema: {
        name: 'ui_forge',
        description: 'Causyne UI Forge: Generate production-grade accessible, responsive UI components (cards, dashboards, forms, tables) and design systems. Emits clean semantic HTML/CSS, React+Tailwind, or Svelte/Vue with a self-contained live preview.',
        parameters: {
            type: 'object',
            properties: {
                framework: {
                    type: 'string',
                    enum: ['html-css', 'react', 'vue', 'svelte'],
                    description: 'Target frontend framework. Defaults to "html-css" (zero-dependency semantic HTML + Vanilla CSS).'
                },
                spec: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Component PascalCase name, e.g. AnalyticsCard.' },
                        type: {
                            type: 'string',
                            enum: ['card', 'navbar', 'form', 'dashboard-stats', 'table', 'modal', 'custom'],
                            description: 'Pattern type.'
                        },
                        title: { type: 'string', description: 'Header or component title.' },
                        description: { type: 'string', description: 'Subtitle or descriptive text.' },
                        theme: { type: 'string', enum: ['dark', 'light'], description: 'Theme palette (dark or light).' },
                        items: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    id: { type: 'string' },
                                    label: { type: 'string' },
                                    value: { type: ['string', 'number'] },
                                    description: { type: 'string' }
                                },
                                required: ['label']
                            },
                            description: 'List of data items, metrics, fields or elements.'
                        },
                        actions: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    label: { type: 'string' },
                                    action: { type: 'string' },
                                    primary: { type: 'boolean' }
                                },
                                required: ['label', 'action']
                            },
                            description: 'Interactive button actions.'
                        }
                    },
                    required: ['type']
                },
                outputPath: {
                    type: 'string',
                    description: 'Optional file path to write the generated component and preview directly to workspace, e.g. "src/components/AnalyticsCard.html".'
                }
            },
            required: ['spec']
        }
    },
    async execute(args = {}, context) {
        if (!args || typeof args !== 'object' || Array.isArray(args) || !args.spec || typeof args.spec !== 'object' || Array.isArray(args.spec) || !args.spec.type) {
            return { success: false, error: 'UI Forge specification with a valid component "type" is required.' };
        }
        const framework = args.framework || 'html-css';
        const spec = args.spec;
        let code = '';
        let css = '';
        let previewHtml = '';
        if (framework === 'react') {
            code = generateReactComponent(spec);
            const htmlComp = generateHtmlComponent(spec);
            css = htmlComp.css;
            previewHtml = generatePreviewHtml(htmlComp.html, htmlComp.css, spec.theme || 'dark');
        }
        else {
            const htmlComp = generateHtmlComponent(spec);
            code = htmlComp.html;
            css = htmlComp.css;
            previewHtml = generatePreviewHtml(htmlComp.html, htmlComp.css, spec.theme || 'dark');
        }
        let writtenFiles = [];
        if (typeof args.outputPath === 'string' && args.outputPath.trim()) {
            try {
                const trimmedOut = args.outputPath.trim();
                const isHome = trimmedOut === '~' || trimmedOut.startsWith('~/') || trimmedOut.startsWith('~\\');
                const baseRoot = context?.parentLoop?.workspaceRoot?.trim()
                    || context?.workspaceRoot?.trim()
                    || context?.workspacePaths?.find((p) => typeof p === 'string' && p.trim().length > 0)?.trim();
                const resolved = isHome
                    ? resolveUserPath(trimmedOut)
                    : path.isAbsolute(trimmedOut)
                        ? path.resolve(trimmedOut)
                        : path.resolve(baseRoot ? resolveUserPath(baseRoot) : process.cwd(), trimmedOut);
                const dir = path.dirname(resolved);
                const ext = path.extname(resolved);
                const previewFile = path.join(dir, `${path.basename(resolved, ext)}.preview.html`);
                assertUiWriteScope(resolved, context);
                assertUiWriteScope(previewFile, context);
                if (!fs.existsSync(dir))
                    fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(resolved, code, 'utf8');
                writtenFiles.push(resolved);
                fs.writeFileSync(previewFile, previewHtml, 'utf8');
                writtenFiles.push(previewFile);
            }
            catch (err) {
                return { success: false, error: `Failed to write component files: ${err.message}` };
            }
        }
        const reportLines = [
            `Generated ${spec.type} component using Causyne UI Forge (${framework}).`,
            `Theme: ${spec.theme || 'dark'} | Items: ${(spec.items || []).length} | Actions: ${(spec.actions || []).length}`
        ];
        if (writtenFiles.length > 0) {
            reportLines.push(`Saved component file: ${writtenFiles[0]}`);
            reportLines.push(`Saved preview file:   ${writtenFiles[1]}`);
        }
        else {
            reportLines.push('', '--- Component Code ---', code);
        }
        const res = {
            success: true,
            output: reportLines.join('\n'),
            code
        };
        if (writtenFiles[1])
            res.previewPath = writtenFiles[1];
        return res;
    }
};
