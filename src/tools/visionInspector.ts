import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ensureCapability, loadCapabilityPackage } from '../provisioning/capabilityProvisioner.js';

const execFileAsync = promisify(execFile);

interface VisionArgs {
  target: 'desktop' | 'android_adb';
  prompt: string;
  deviceSerial?: string;
}

interface OcrWord {
  text: string;
  confidence: number;
  bbox: { x0: number; x1: number; y0: number; y1: number };
}

export const visionInspector = {
  schema: {
    name: 'vision.inspect_ui',
    description: 'Capture a live desktop or Android screen and pass its pixels to a vision-capable model. OCR coordinates are included when the OCR capability is available. A capture failure is not visual verification.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['desktop', 'android_adb'] },
        prompt: { type: 'string', description: 'What to inspect in the captured UI.' },
        deviceSerial: { type: 'string', description: 'Optional Android ADB device serial.' }
      },
      required: ['target', 'prompt']
    }
  },

  async execute(args: VisionArgs) {
    const target = args.target;
    if (target !== 'desktop' && target !== 'android_adb') {
      return { success: false, error: 'target must be desktop or android_adb' };
    }
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-vision-inspect-'));
    const imagePath = path.join(tempDir, 'screen.png');
    try {
      if (target === 'android_adb') {
        const adbArgs = args.deviceSerial ? ['-s', args.deviceSerial] : [];
        const { stdout } = await execFileAsync('adb', [...adbArgs, 'shell', 'screencap', '-p'], {
          encoding: 'buffer', maxBuffer: 20 * 1024 * 1024
        });
        const bytes = process.platform === 'win32'
          ? Buffer.from(stdout.toString('binary').replace(/\r\n/g, '\n'), 'binary')
          : stdout;
        await fs.writeFile(imagePath, bytes);
      } else {
        const vision = await ensureCapability('vision');
        if (!vision.ok) return { success: false, error: vision.reason, requiresConsent: vision.requiresConsent };
        const capture = await loadCapabilityPackage('screenshot-desktop') as (options: { filename: string }) => Promise<void>;
        await capture({ filename: imagePath });
      }

      const bytes = await fs.readFile(imagePath);
      if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024) {
        return { success: false, error: 'Captured image is empty or exceeds 20 MB' };
      }

      let ocrOutput = 'OCR was not available for this capture.';
      try {
        const ocr = await ensureCapability('ocr');
        if (ocr.ok) {
          const tesseract = await loadCapabilityPackage('tesseract.js') as {
            createWorker(language: string): Promise<{
              recognize(file: string): Promise<{ data?: { words?: OcrWord[] } }>;
              terminate(): Promise<void>;
            }>;
          };
          const worker = await tesseract.createWorker('eng');
          try {
            const recognized = await worker.recognize(imagePath);
            const words = (recognized.data?.words ?? []).filter(word => word.confidence > 75).slice(0, 30);
            ocrOutput = words.length > 0
              ? words.map(word => `- [${word.text}] X:${Math.floor((word.bbox.x0 + word.bbox.x1) / 2)}, Y:${Math.floor((word.bbox.y0 + word.bbox.y1) / 2)}`).join('\n')
              : 'No confident OCR text tokens detected.';
          } finally {
            await worker.terminate();
          }
        }
      } catch (error: unknown) {
        ocrOutput = `OCR unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }

      return {
        success: true,
        _is_image_marker: true,
        mimeType: 'image/png',
        base64: bytes.toString('base64'),
        filename: `${target} screenshot`,
        output: `Capture prompt: ${args.prompt}\n${ocrOutput}`
      };
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      const guidance = process.platform === 'darwin' && /could not create image from display/i.test(reason)
        ? ' macOS could not capture the display. Check Screen Recording access for the terminal app and that a display session is available; then restart the terminal.'
        : '';
      return { success: false, error: `Live screen capture failed: ${reason}.${guidance}` };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
};
