import fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
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
      if (!args || !args.path) {
        return { success: false, error: 'Missing required argument: path' };
      }

      const targetPath = resolveUserPath(args.path);
      if (!existsSync(targetPath)) {
        return { success: false, error: `Image not found at ${targetPath}` };
      }

      const stat = statSync(targetPath);
      if (stat.size > 25 * 1024 * 1024) {
        return { success: false, error: 'Image too large. Maximum raw size is 25MB.' };
      }

      // OCR Fallback for Text-Only LLMs if explicitly requested or sandbox is strictly non-vision
      const forceOcr = Boolean(args.extractTextOnly || (sandbox && sandbox.llmSupportsVision === false));

      if (forceOcr) {
        try {
          const Tesseract: any = await loadCapabilityPackage('tesseract.js');
          if (Tesseract && typeof Tesseract.createWorker === 'function') {
            const worker = await Tesseract.createWorker('eng');
            const { data: { text } } = await worker.recognize(targetPath);
            await worker.terminate();
            return { success: true, output: `[OCR Text Extracted from ${path.basename(targetPath)}]:\n\n${text}` };
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
      const ext = path.extname(targetPath).toLowerCase();

      try {
        const sharp = await loadCapabilityPackage('sharp');
        if (typeof sharp === 'function') {
          processedBuffer = await sharp(targetPath)
            .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();
        } else {
          processedBuffer = await fs.readFile(targetPath);
        }
      } catch {
        processedBuffer = await fs.readFile(targetPath);
      }

      if (ext === '.png') mimeType = 'image/png';
      else if (ext === '.webp') mimeType = 'image/webp';
      else if (ext === '.gif') mimeType = 'image/gif';
      else if (ext === '.svg') mimeType = 'image/svg+xml';
      else if (ext === '.bmp') mimeType = 'image/bmp';

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
