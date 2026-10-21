/*
 * Copyright (c) 2011-2024 Thesys Inc.
 * SPDX-License-Identifier: MIT
 *
 * OpenUI Generative Component Tool for Causyne Agent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { generateHtmlComponent, generatePreviewHtml, generateReactComponent } from '../uiEngine/openUi.js';
import { resolveUserPath } from '../utils/paths.js';
export const openUiTool = {
    schema: {
        name: 'openui_generate',
        description: 'Generate production-grade accessible, responsive UI components (cards, dashboards, forms, tables) using OpenUI component specifications. Emits clean semantic HTML/CSS, React+Tailwind, or Svelte/Vue with a self-contained live preview.',
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
    async execute(args = {}) {
        if (!args.spec || !args.spec.type) {
            return { success: false, error: 'OpenUI specification with a valid component "type" is required.' };
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
        if (args.outputPath) {
            try {
                const resolved = resolveUserPath(args.outputPath);
                const dir = path.dirname(resolved);
                if (!fs.existsSync(dir))
                    fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(resolved, code, 'utf8');
                writtenFiles.push(resolved);
                // Also write standalone preview alongside
                const ext = path.extname(resolved);
                const previewFile = path.join(dir, `${path.basename(resolved, ext)}.preview.html`);
                fs.writeFileSync(previewFile, previewHtml, 'utf8');
                writtenFiles.push(previewFile);
            }
            catch (err) {
                return { success: false, error: `Failed to write component files: ${err.message}` };
            }
        }
        const reportLines = [
            `Generated ${spec.type} component using OpenUI engine (${framework}).`,
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
