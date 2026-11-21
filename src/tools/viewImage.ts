import fs from 'node:fs/promises';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveUserPath } from '../utils/paths.js';
import { loadCapabilityPackage } from '../provisioning/capabilityProvisioner.js';

export interface ViewImageArgs {
  path: string;
  extractTextOnly?: boolean;
}

export interface ViewImageResult {
  _is_image_marker?: boolean;
  success?: boolean;
  output?: string;
  error?: string;
  mimeType?: string;
  base64?: string;
  filename?: string;
  path?: string;
  requiresConsent?: boolean;
}

export const viewImage = {
  schema: {
    name: 'view_image',
    description: 'Multi-Modal Pre-Processing Engine. View an image file from disk. Automatically normalizes and compresses huge images to save tokens. For text-only LLMs or document scans, extracts text via OCR.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to the image file' },
        extractTextOnly: { type: 'boolean', description: 'If true, skips Vision APIs and uses local OCR to read text from the image.' }
      },
      required: ['path']
    }
  },

  execute: async (args: ViewImageArgs, sandbox?: any): Promise<ViewImageResult> => {
    try {
      if (!args || typeof args !== 'object' || typeof args.path !== 'string' || !args.path.trim()) {
        return { success: false, error: 'Missing required argument: path' };
      }

      const rawPath = args.path.trim();
      const isHome = rawPath === '~' || rawPath.startsWith('~/') || rawPath.startsWith('~\\');
      const baseRoot = sandbox?.parentLoop?.workspaceRoot?.trim?.()
        || sandbox?.workspaceRoot?.trim?.()
        || (Array.isArray(sandbox?.workspacePaths)
          ? sandbox.workspacePaths.find((p: unknown): p is string => typeof p === 'string' && p.trim().length > 0)?.trim()
          : undefined);
      const targetPath = isHome
        ? resolveUserPath(rawPath)
        : path.isAbsolute(rawPath)
          ? path.resolve(rawPath)
          : path.resolve(baseRoot ? resolveUserPath(baseRoot) : process.cwd(), rawPath);

      if (!existsSync(targetPath)) {
        return { success: false, error: `Image not found at ${targetPath}` };
      }

      if (sandbox && sandbox.grantAllAccess !== true) {
        const policy = sandbox?.parentLoop?.sandbox ?? sandbox;
        if (typeof policy?.isPathAllowed === 'function' && !policy.isPathAllowed(targetPath)) {
          return { success: false, error: `Image path resolves outside allowed workspace: ${targetPath}` };
        }
        const configuredRoots = Array.isArray(sandbox.workspacePaths)
          ? sandbox.workspacePaths.filter((p: unknown): p is string => typeof p === 'string' && p.trim().length > 0)
          : [sandbox?.parentLoop?.workspaceRoot, sandbox?.workspaceRoot].filter((p: unknown): p is string => typeof p === 'string' && p.trim().length > 0);
        if (configuredRoots.length > 0) {
          const realTarget = realpathSync(targetPath);
          const allowed = configuredRoots.some((root: string) => {
            try {
              const realRoot = realpathSync(resolveUserPath(root));
              const rel = path.relative(realRoot, realTarget);
              return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
            } catch {
              return false;
            }
          });
          if (!allowed) {
            return { success: false, error: `Image path resolves outside allowed workspace: ${targetPath}` };
          }
        }
      }

      const stat = statSync(targetPath);
      if (!stat.isFile()) {
        return { success: false, error: `Image path is not a regular file: ${targetPath}` };
      }
      if (stat.size > 25 * 1024 * 1024) {
        return { success: false, error: 'Image too large. Maximum raw size is 25MB.' };
      }

      // OCR Fallback for Text-Only LLMs if explicitly requested or sandbox is strictly non-vision
      const forceOcr = args.extractTextOnly === true || Boolean(sandbox && sandbox.llmSupportsVision === false);

      if (forceOcr) {
        try {
          const Tesseract: any = await loadCapabilityPackage('tesseract.js');
          if (Tesseract && typeof Tesseract.createWorker === 'function') {
            const worker = await Tesseract.createWorker('eng');
            try {
              const { data: { text } } = await worker.recognize(targetPath);
              return { success: true, output: `[OCR Text Extracted from ${path.basename(targetPath)}]:\n\n${text}` };
            } finally {
              await worker.terminate().catch(() => {});
            }
          }
        } catch {
          // If tesseract isn't provisioned, fall through to returning image data if not explicitly text-only
          if (args.extractTextOnly) {
            return {
              success: false,
              error: `OCR package tesseract.js is not loaded. To view the image directly, omit extractTextOnly.`
            };
          }
        }
      }

      // Vision image reading & normalization
      let processedBuffer: Buffer;
      let mimeType = 'image/jpeg';
      let reencodedAsJpeg = false;
      const ext = path.extname(targetPath).toLowerCase();

      try {
        const sharp = await loadCapabilityPackage('sharp');
        if (typeof sharp === 'function') {
          processedBuffer = await sharp(targetPath)
            .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();
          reencodedAsJpeg = true;
        } else {
          processedBuffer = await fs.readFile(targetPath);
        }
      } catch {
        processedBuffer = await fs.readFile(targetPath);
      }

      if (!reencodedAsJpeg) {
        if (ext === '.png') mimeType = 'image/png';
        else if (ext === '.webp') mimeType = 'image/webp';
        else if (ext === '.gif') mimeType = 'image/gif';
        else if (ext === '.svg') mimeType = 'image/svg+xml';
        else if (ext === '.bmp') mimeType = 'image/bmp';
      }

      const base64 = processedBuffer.toString('base64');

      return {
        _is_image_marker: true,
        success: true,
        mimeType,
        base64,
        filename: path.basename(targetPath),
        path: targetPath
      };
    } catch (error: any) {
      return { success: false, error: `Error viewing image: ${error?.message || String(error)}` };
    }
  }
};
