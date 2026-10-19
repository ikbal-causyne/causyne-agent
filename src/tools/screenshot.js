import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ensureCapability, loadCapabilityPackage } from '../provisioning/capabilityProvisioner.js';

export const screenshot = {
  schema: {
    name: 'screenshot',
    description: 'Visual Spatial Coordinator. Captures the screen and uses OCR to extract Bounding Box (X,Y) coordinates of UI elements, allowing AGI to "see" the OS.',
    parameters: {
      type: 'object',
      properties: {
        analyzeText: { type: 'boolean', description: 'If true, runs OCR to map text coordinates.' }
      }
    }
  },
  async execute(args) {
    try {
      const vision = await ensureCapability('vision');
      if (!vision.ok) return { success: false, error: vision.reason, requiresConsent: vision.requiresConsent };
      const screenshotDesktop = await loadCapabilityPackage('screenshot-desktop');

      const tempDir = path.join(os.tmpdir(), 'causyne_vision');
      await fs.mkdir(tempDir, { recursive: true });
      const dest = path.join(tempDir, `vision_${Date.now()}.png`);

      // Phase 5 AGI Upgrade: Cross-Platform Native Capture
      await screenshotDesktop({ filename: dest });

      if (!args.analyzeText) {
        return { success: true, output: `Screenshot saved to ${dest}` };
      }

      // Phase 5 AGI Upgrade: OCR Bounding Box Integration
      const ocr = await ensureCapability('ocr');
      if (!ocr.ok) {
        await fs.unlink(dest);
        return { success: false, error: ocr.reason, requiresConsent: ocr.requiresConsent };
      }
      const Tesseract = await loadCapabilityPackage('tesseract.js');

      // Tesseract runs in its own Worker thread automatically
      const worker = await Tesseract.createWorker('eng');
      const { data: { words } } = await worker.recognize(dest);
      await worker.terminate();
      
      // Delete temporary image to protect privacy
      await fs.unlink(dest);

      if (!words || words.length === 0) {
        return { success: true, output: "Screenshot taken, but no readable text found on screen." };
      }

      let markdownMap = `👁️ OS Visual Spatial Map:\n\n`;
      // We'll return the top 50 most confident words to prevent context overload
      const confidentWords = words.filter(w => w.confidence > 75).slice(0, 50);
      
      for (const w of confidentWords) {
        const { x0, y0, x1, y1 } = w.bbox;
        const centerX = Math.floor((x0 + x1) / 2);
        const centerY = Math.floor((y0 + y1) / 2);
        markdownMap += `- Text: "${w.text}" | Center Coordinates: X:${centerX}, Y:${centerY} | Confidence: ${w.confidence.toFixed(1)}%\n`;
      }
      
      if (words.length > 50) {
        markdownMap += `\n[... Truncated ${words.length - 50} elements to protect AGI Context ...]`;
      }

      return { success: true, output: markdownMap };

    } catch (e) {
      return { success: false, error: `Vision Error: ${e.message}` };
    }
  }
};
