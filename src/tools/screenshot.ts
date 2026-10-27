import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ensureCapability, loadCapabilityPackage } from '../provisioning/capabilityProvisioner.js';

interface ScreenshotArgs { analyzeText?: boolean }

export const screenshot = {
  schema: {
    name: 'screenshot',
    description: 'Capture the local desktop after the vision capability is granted and pass the image to the active vision model. Optional OCR extracts visible text.',
    parameters: {
      type: 'object',
      properties: {
        analyzeText: { type: 'boolean', description: 'Return OCR text instead of the image.' }
      }
    }
  },

  async execute(args: ScreenshotArgs = {}) {
    const vision = await ensureCapability('vision');
    if (!vision.ok) return { success: false, error: vision.reason, requiresConsent: vision.requiresConsent };

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-vision-'));
    const imagePath = path.join(tempDir, 'screen.png');
    try {
      const capture = await loadCapabilityPackage('screenshot-desktop') as (options: { filename: string }) => Promise<void>;
      await capture({ filename: imagePath });
      const bytes = await fs.readFile(imagePath);
      if (bytes.length > 20 * 1024 * 1024) return { success: false, error: 'Screenshot exceeds 20 MB' };

      if (args.analyzeText) {
        const ocr = await ensureCapability('ocr');
        if (!ocr.ok) return { success: false, error: ocr.reason, requiresConsent: ocr.requiresConsent };
        const Tesseract = await loadCapabilityPackage('tesseract.js') as {
          createWorker(language: string): Promise<{
            recognize(file: string): Promise<{ data?: { words?: unknown[] } }>;
            terminate(): Promise<void>;
          }>;
        };
        const worker = await Tesseract.createWorker('eng');
        try {
          const recognized = await worker.recognize(imagePath);
          const words = (recognized.data?.words ?? []) as Array<{
            text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number };
          }>;
          const output = words.filter(word => word.confidence > 75).slice(0, 50).map(word =>
            `${word.text} at ${Math.floor((word.bbox.x0 + word.bbox.x1) / 2)},${Math.floor((word.bbox.y0 + word.bbox.y1) / 2)}`
          ).join('\n');
          return { success: true, output: output || 'Screenshot captured; no readable text detected.' };
        } finally {
          await worker.terminate();
        }
      }

      return {
        success: true,
        _is_image_marker: true,
        mimeType: 'image/png',
        base64: bytes.toString('base64'),
        filename: 'desktop screenshot'
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const guidance = process.platform === 'darwin' && /could not create image from display/i.test(reason)
        ? ' macOS could not capture the display. Check Screen Recording access for the terminal app and that a display session is available; then restart the terminal.'
        : '';
      return { success: false, error: `Screen capture failed: ${reason}.${guidance}` };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
};
