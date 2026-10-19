import fs from 'fs/promises';
import { resolveUserPath } from '../utils/paths.js';
import { existsSync, statSync } from 'fs';
import path from 'path';
import os from 'os';
import { ensureCapability, loadCapabilityPackage } from '../provisioning/capabilityProvisioner.js';

export const viewImage = {
  schema: {
    name: 'view_image',
    description: 'Multi-Modal Pre-Processing Engine. View an image file from disk. Automatically compresses huge images to save tokens. For text-only LLMs, it autonomously extracts text via OCR.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to the image file' },
        extractTextOnly: { type: 'boolean', description: 'If true, skips Vision APIs and uses local OCR to read text from the image.' }
      },
      required: ['path']
    }
  },
  
  execute: async (args, sandbox) => {
    try {
      const targetPath = resolveUserPath(args.path);
      if (!existsSync(targetPath)) {
        return { success: false, error: `Image not found at ${targetPath}` };
      }
      
      const stat = statSync(targetPath);
      if (stat.size > 20 * 1024 * 1024) { 
        return { success: false, error: 'Image too large. Maximum raw size is 20MB.' };
      }

      // Phase 6 AGI Upgrade: OCR Fallback for Text-Only LLMs
      const forceOcr = args.extractTextOnly || (sandbox && sandbox.llmSupportsVision === false);
      
      if (forceOcr) {
        const ocr = await ensureCapability('ocr');
        if (!ocr.ok) return { success: false, error: ocr.reason, requiresConsent: ocr.requiresConsent };
        const Tesseract = await loadCapabilityPackage('tesseract.js');
        
        const worker = await Tesseract.createWorker('eng');
        const { data: { text } } = await worker.recognize(targetPath);
        await worker.terminate();
        
        return { success: true, output: `[OCR FALLBACK] Extracted Text from Image:\n\n${text}` };
      }
      
      // Phase 6 AGI Upgrade: Dynamic Resizing & Format Normalization
      let processedBuffer;
      let mimeType = 'image/jpeg';
      
      try {
        // sharp already lives in the Cortex tree as a pinned override, so it is
        // loaded from there rather than installed a second time.
        const sharp = await loadCapabilityPackage('sharp');
        processedBuffer = await sharp(targetPath)
          .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer();
      } catch (e) {
        // Fallback if sharp is missing (return raw buffer but warn)
        processedBuffer = await fs.readFile(targetPath);
        const ext = path.extname(targetPath).toLowerCase();
        if (ext === '.png') mimeType = 'image/png';
        else if (ext === '.webp') mimeType = 'image/webp';
        else if (ext === '.gif') mimeType = 'image/gif';
      }
      
      const base64 = processedBuffer.toString('base64');
      
      return {
        _is_image_marker: true,
        mimeType,
        base64,
        filename: path.basename(targetPath)
      };
    } catch (error) {
      return { success: false, error: `Error viewing image: ${error.message}` };
    }
  }
};
