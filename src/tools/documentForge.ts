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
import {
  compileDocumentHtml,
  renderHtmlToPdf,
  inspectPdfPages,
  type FormalDocumentSpec
} from '../documentEngine/documentForge.js';
import {
  formatScreenplayHtml,
  formatShotListHtml,
  analyzeVoiceOverTiming,
  type ScreenplaySpec,
  type ProductionShot,
  type VoBlock
} from '../documentEngine/screenplayFormatter.js';
import {
  auditTextContent,
  auditBudgetArithmetic,
  type ArithmeticBudgetSpec
} from '../documentEngine/antiSlopAuditor.js';
import { resolveUserPath } from '../utils/paths.js';

export interface DocumentForgeArgs {
  action?:
    | 'compile_document'
    | 'render_pdf'
    | 'inspect_pages'
    | 'audit_text'
    | 'audit_budget'
    | 'format_screenplay'
    | 'format_shotlist'
    | 'analyze_vo';
  documentSpec?: FormalDocumentSpec;
  screenplaySpec?: ScreenplaySpec;
  shotList?: { title: string; shots: ProductionShot[] };
  voBlocks?: VoBlock[];
  budgetSpec?: ArithmeticBudgetSpec;
  textContent?: string;
  sourceHtmlPath?: string;
  outputPdfPath?: string;
  outputPath?: string;
  inspectImagesDir?: string;
}

interface DocumentForgeContext {
  workspaceRoot?: string;
  workspacePaths?: string[];
  grantAllAccess?: boolean;
  parentLoop?: { workspaceRoot?: string };
}

function resolveDocPath(raw: string, context?: DocumentForgeContext): string {
  const trimmed = raw.trim();
  if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return resolveUserPath(trimmed);
  }
  if (path.isAbsolute(trimmed)) return path.resolve(trimmed);
  const baseRoot = context?.parentLoop?.workspaceRoot?.trim()
    || context?.workspaceRoot?.trim()
    || context?.workspacePaths?.find((p): p is string => typeof p === 'string' && p.trim().length > 0)?.trim();
  return path.resolve(baseRoot ? resolveUserPath(baseRoot) : process.cwd(), trimmed);
}

function canonicalDocPath(target: string): string {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch {
    let current = resolved;
    const missing: string[] = [];
    for (let i = 0; i < 64; i++) {
      const parent = path.dirname(current);
      if (parent === current) break;
      missing.unshift(path.basename(current));
      current = parent;
      try {
        return path.join(fs.realpathSync(current), ...missing);
      } catch {
        continue;
      }
    }
    return resolved;
  }
}

function assertDocScope(target: string, context?: DocumentForgeContext, isWrite = false): void {
  if (isWrite && fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new Error(`Refusing to overwrite symbolic link: ${target}`);
  }
  if (!context || context.grantAllAccess === true) return;
  const configured = Array.isArray(context.workspacePaths)
    ? context.workspacePaths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map(p => p.trim())
    : [];
  const roots = configured.length > 0
    ? configured
    : [context.parentLoop?.workspaceRoot, context.workspaceRoot]
      .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      .map(p => p.trim());
  if (roots.length === 0) return;
  const physical = canonicalDocPath(target);
  for (const root of roots) {
    try {
      const realRoot = fs.realpathSync(resolveUserPath(root));
      const rel = path.relative(realRoot, physical);
      if (rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))) return;
    } catch {
      continue;
    }
  }
  throw new Error(`Document path resolves outside the selected workspace: ${target}`);
}

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

  async execute(args: DocumentForgeArgs = {}, context: DocumentForgeContext = {}): Promise<{ success: boolean; [key: string]: any }> {
    try {
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return { success: false, error: 'document_forge requires an arguments object.' };
      }
      const action = args.action || 'compile_document';

      switch (action) {
        case 'compile_document': {
          if (!args.documentSpec) {
            return { success: false, error: 'compile_document requires documentSpec.' };
          }
          const compiled = compileDocumentHtml(args.documentSpec);
          let resolvedOut: string | undefined;
          if (args.outputPath) {
            resolvedOut = resolveDocPath(args.outputPath, context);
            assertDocScope(resolvedOut, context, true);
            fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
            fs.writeFileSync(resolvedOut, compiled.html, 'utf8');
          }
          return {
            success: true,
            html: compiled.html,
            outputPath: resolvedOut
          };
        }

        case 'render_pdf': {
          if (!args.sourceHtmlPath || !args.outputPdfPath) {
            return { success: false, error: 'render_pdf requires sourceHtmlPath and outputPdfPath.' };
          }
          const src = resolveDocPath(args.sourceHtmlPath, context);
          const out = resolveDocPath(args.outputPdfPath, context);
          assertDocScope(src, context, false);
          assertDocScope(out, context, true);
          const res = await renderHtmlToPdf(src, out);
          return res;
        }

        case 'inspect_pages': {
          if (!args.outputPdfPath) {
            return { success: false, error: 'inspect_pages requires outputPdfPath.' };
          }
          const pdf = resolveDocPath(args.outputPdfPath, context);
          assertDocScope(pdf, context, false);
          const imgDir = args.inspectImagesDir ? resolveDocPath(args.inspectImagesDir, context) : undefined;
          if (imgDir) assertDocScope(imgDir, context, true);
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
          let resolvedOut: string | undefined;
          if (args.outputPath) {
            resolvedOut = resolveDocPath(args.outputPath, context);
            assertDocScope(resolvedOut, context, true);
            fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
            fs.writeFileSync(resolvedOut, formatted.html, 'utf8');
          }
          return {
            success: true,
            html: formatted.html,
            outputPath: resolvedOut
          };
        }

        case 'format_shotlist': {
          if (!args.shotList || !Array.isArray(args.shotList.shots)) {
            return { success: false, error: 'format_shotlist requires shotList with a shots array.' };
          }
          const formatted = formatShotListHtml(args.shotList.title, args.shotList.shots);
          let resolvedOut: string | undefined;
          if (args.outputPath) {
            resolvedOut = resolveDocPath(args.outputPath, context);
            assertDocScope(resolvedOut, context, true);
            fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
            fs.writeFileSync(resolvedOut, formatted.html, 'utf8');
          }
          return {
            success: true,
            html: formatted.html,
            outputPath: resolvedOut
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
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
};
