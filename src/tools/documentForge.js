/*
 * Copyright (c) 2026 Causyne.
 * SPDX-License-Identifier: BUSL-1.1
 *
 * Causyne Document Forge Tool Wrapper.
 * Bridges HTML/CSS-first publishing, headless PDF compilation, visual page QA,
 * anti-slop compliance auditing, and Hollywood screenplay & shot list generation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { compileDocumentHtml, renderHtmlToPdf, inspectPdfPages } from '../documentEngine/documentForge.js';
import { formatScreenplayHtml, formatShotListHtml, analyzeVoiceOverTiming } from '../documentEngine/screenplayFormatter.js';
import { auditTextContent, auditBudgetArithmetic } from '../documentEngine/antiSlopAuditor.js';
import { resolveUserPath } from '../utils/paths.js';
export const documentForgeTool = {
    schema: {
        name: 'document_forge',
        description: 'Causyne Document Forge: Professional document & media production harness. Generates pixel-perfect A4/Letter publications via HTML/CSS-First Paged Media and Headless Chrome, renders vector PDFs (<2MB compliant), extracts page images for visual QA ("Inspect Results"), audits anti-slop and math integrity, formats Hollywood Courier 12pt screenplays, creates production shot lists, and times VO narration.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: [
                        'compile_document',
                        'render_pdf',
                        'inspect_pages',
                        'audit_text',
                        'audit_budget',
                        'format_screenplay',
                        'format_shotlist',
                        'analyze_vo'
                    ],
                    description: 'Action to execute.'
                },
                documentSpec: {
                    type: 'object',
                    properties: {
                        title: { type: 'string' },
                        subtitle: { type: 'string' },
                        categoryOrKicker: { type: 'string' },
                        authorOrProposer: { type: 'string' },
                        palette: { type: 'string', enum: ['corporate', 'editorial_dair', 'minimal_clean'] },
                        includeCover: { type: 'boolean' }
                    },
                    description: 'Formal publication spec with sections, tables, and palette (corporate, editorial_dair, minimal_clean).'
                },
                screenplaySpec: {
                    type: 'object',
                    properties: {
                        title: { type: 'string' },
                        author: { type: 'string' },
                        contact: { type: 'string' }
                    },
                    description: 'Hollywood screenplay spec with scene headings, action, characters, dialogue, and transitions.'
                },
                shotList: {
                    type: 'object',
                    properties: {
                        title: { type: 'string' },
                        shots: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    shotNumber: { type: 'number' },
                                    framing: { type: 'string' },
                                    subject: { type: 'string' },
                                    action: { type: 'string' },
                                    durationSeconds: { type: 'number' }
                                }
                            }
                        }
                    },
                    description: 'Director production shot list with framing, lenses, camera movements, and audio cues.'
                },
                voBlocks: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string' },
                            timecode: { type: 'string' },
                            text: { type: 'string' },
                            targetDurationSeconds: { type: 'number' }
                        }
                    },
                    description: 'Voiceover blocks with timecode and target durations for WPM pacing analysis.'
                },
                budgetSpec: {
                    type: 'object',
                    properties: {
                        grossUpTaxRate: { type: 'number' },
                        targetGross: { type: 'number' }
                    },
                    description: 'Budget specification for arithmetic validation and tax gross-up verification.'
                },
                textContent: {
                    type: 'string',
                    description: 'Raw text or HTML content to audit for AI tropes, long em-dashes, and placeholder brackets.'
                },
                sourceHtmlPath: {
                    type: 'string',
                    description: 'Path to HTML file to render into PDF via Headless Chrome.'
                },
                outputPdfPath: {
                    type: 'string',
                    description: 'Destination PDF file path.'
                },
                outputPath: {
                    type: 'string',
                    description: 'Destination HTML or JSON output file path.'
                },
                inspectImagesDir: {
                    type: 'string',
                    description: 'Directory to save extracted page images for visual inspection.'
                }
            }
        }
    },
    async execute(args = {}, _context = {}) {
        const action = args.action || 'compile_document';
        switch (action) {
            case 'compile_document': {
                if (!args.documentSpec) {
                    return { success: false, error: 'compile_document requires documentSpec.' };
                }
                const compiled = compileDocumentHtml(args.documentSpec);
                if (args.outputPath) {
                    const target = resolveUserPath(args.outputPath);
                    fs.mkdirSync(path.dirname(target), { recursive: true });
                    fs.writeFileSync(target, compiled.html, 'utf8');
                }
                return {
                    success: true,
                    html: compiled.html,
                    outputPath: args.outputPath ? resolveUserPath(args.outputPath) : undefined
                };
            }
            case 'render_pdf': {
                if (!args.sourceHtmlPath || !args.outputPdfPath) {
                    return { success: false, error: 'render_pdf requires sourceHtmlPath and outputPdfPath.' };
                }
                const src = resolveUserPath(args.sourceHtmlPath);
                const out = resolveUserPath(args.outputPdfPath);
                const res = await renderHtmlToPdf(src, out);
                return res;
            }
            case 'inspect_pages': {
                if (!args.outputPdfPath) {
                    return { success: false, error: 'inspect_pages requires outputPdfPath.' };
                }
                const pdf = resolveUserPath(args.outputPdfPath);
                const imgDir = args.inspectImagesDir ? resolveUserPath(args.inspectImagesDir) : undefined;
                const res = await inspectPdfPages(pdf, imgDir);
                return res;
            }
            case 'audit_text': {
                if (!args.textContent) {
                    return { success: false, error: 'audit_text requires textContent parameter.' };
                }
                const res = auditTextContent(args.textContent);
                return { success: true, ...res };
            }
            case 'audit_budget': {
                if (!args.budgetSpec) {
                    return { success: false, error: 'audit_budget requires budgetSpec parameter.' };
                }
                const res = auditBudgetArithmetic(args.budgetSpec);
                return { success: true, ...res };
            }
            case 'format_screenplay': {
                if (!args.screenplaySpec) {
                    return { success: false, error: 'format_screenplay requires screenplaySpec.' };
                }
                const formatted = formatScreenplayHtml(args.screenplaySpec);
                if (args.outputPath) {
                    const target = resolveUserPath(args.outputPath);
                    fs.mkdirSync(path.dirname(target), { recursive: true });
                    fs.writeFileSync(target, formatted.html, 'utf8');
                }
                return {
                    success: true,
                    html: formatted.html,
                    outputPath: args.outputPath ? resolveUserPath(args.outputPath) : undefined
                };
            }
            case 'format_shotlist': {
                if (!args.shotList) {
                    return { success: false, error: 'format_shotlist requires shotList parameter.' };
                }
                const formatted = formatShotListHtml(args.shotList.title, args.shotList.shots);
                if (args.outputPath) {
                    const target = resolveUserPath(args.outputPath);
                    fs.mkdirSync(path.dirname(target), { recursive: true });
                    fs.writeFileSync(target, formatted.html, 'utf8');
                }
                return {
                    success: true,
                    html: formatted.html,
                    outputPath: args.outputPath ? resolveUserPath(args.outputPath) : undefined
                };
            }
            case 'analyze_vo': {
                if (!args.voBlocks || !Array.isArray(args.voBlocks)) {
                    return { success: false, error: 'analyze_vo requires voBlocks array.' };
                }
                const res = analyzeVoiceOverTiming(args.voBlocks);
                return { success: true, analysis: res };
            }
            default:
                return { success: false, error: `Unsupported document_forge action: ${action}` };
        }
    }
};
