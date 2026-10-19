import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { ensureCapability, loadCapabilityPackage } from '../provisioning/capabilityProvisioner.js';

const execFileAsync = promisify(execFile);

// Helper: Sovereign Workspace Buffer to prevent /tmp/ boundary errors
function getWorkspaceTempDir() {
  const dir = path.join(process.cwd(), '.tmp_causyne_3d');
  if (!fsSync.existsSync(dir)) {
    fsSync.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export const visionInspector = {
  schema: {
    name: 'vision.inspect_ui',
    description: 'Captures live desktop (macOS/Windows) or mobile (Android via ADB) screenshots directly into the local workspace buffer (.tmp_causyne_3d/) and extracts spatial bounding box coordinates for visual layout verification, LCP debugging, and UI automation.',
    parameters: {
      type: 'object',
      properties: {
        target: { 
          type: 'string', 
          enum: ['desktop', 'android_adb'], 
          description: 'Target device screen to capture: desktop (OS GUI) or android_adb (connected mobile screen).' 
        },
        prompt: { type: 'string', description: 'The verification prompt describing what UI element, visual bug, alignment, or LCP state is being audited.' },
        deviceSerial: { type: 'string', description: 'Optional Android ADB device serial when target is android_adb.' }
      },
      required: ['target', 'prompt']
    }
  },

  async execute(args, context = {}) {
    try {
      const target = args.target || 'desktop';
      const prompt = args.prompt || 'Inspect UI spatial layout';
      const tempDir = getWorkspaceTempDir();
      const timestamp = Date.now();
      const destPath = path.join(tempDir, `ui_inspect_${target}_${timestamp}.png`);

      if (target === 'android_adb') {
        const adbArgs = [];
        if (args.deviceSerial) adbArgs.push('-s', args.deviceSerial);
        adbArgs.push('shell', 'screencap', '-p');

        try {
          const { stdout } = await execFileAsync('adb', adbArgs, { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024 });
          // Handle CRLF on Windows ADB pipes
          let cleanBuffer = stdout;
          if (process.platform === 'win32') {
            cleanBuffer = Buffer.from(stdout.toString('binary').replace(/\r\n/g, '\n'), 'binary');
          }
          await fs.writeFile(destPath, cleanBuffer);
        } catch (adbErr) {
          return {
            success: false,
            error: `ADB Mobile Vision Capture Failed: ${adbErr.message}. Ensure device is connected via ADB USB/WiFi.`
          };
        }
      } else {
        // Desktop OS Screen Capture
        try {
          if (process.platform === 'darwin') {
            await execFileAsync('screencapture', ['-x', destPath]);
          } else if (process.platform === 'win32') {
            const psCmd = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height; $graphics = [System.Drawing.Graphics]::FromImage($bitmap); $graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size); $bitmap.Save('${destPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png); $graphics.Dispose(); $bitmap.Dispose();`;
            await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', psCmd]);
          } else {
            // macOS and Windows capture natively above; only this branch needs
            // the provisioned package.
            const vision = await ensureCapability('vision');
            if (!vision.ok) throw new Error(vision.reason);
            const screenshotDesktop = await loadCapabilityPackage('screenshot-desktop');
            await screenshotDesktop({ filename: destPath });
          }
        } catch (captureErr) {
          
          if (captureErr.message && (captureErr.message.includes('could not create image from display') || captureErr.message.includes('No display') || captureErr.message.includes('xclip'))) {
            // Check if any existing buffer image exists in tempDir to inspect
            const existingFiles = fsSync.readdirSync(tempDir).filter(f => f.endsWith('.png'));
            if (existingFiles.length > 0) {
              const fallbackFile = path.join(tempDir, existingFiles[existingFiles.length - 1]);
              return {
                success: true,
                output: JSON.stringify({
                  status: 'Headless environment detected: GUI capture restricted. Returned latest buffered workspace visual frame.',
                  target_device: target,
                  verification_prompt: prompt,
                  filepath: fallbackFile,
                  workspace_boundary_safe: true,
                  headless_notice: captureErr.message
                }, null, 2)
              };
            }
            return {
              success: true,
              output: JSON.stringify({
                status: 'Live GUI capture is unavailable in this desktop session. Connect an active display or use an ADB mobile target.',
                target_device: target,
                verification_prompt: prompt,
                headless_notice: captureErr.message
              }, null, 2)
            };
          }
          throw captureErr;
        }
      }

      // Check spatial OCR / bounding box extraction
      let textMap = '';
      try {
        const ocr = await ensureCapability('ocr');
        if (!ocr.ok) throw new Error(ocr.reason);
        const Tesseract = await loadCapabilityPackage('tesseract.js');
        const worker = await Tesseract.createWorker('eng');
        const { data: { words } } = await worker.recognize(destPath);
        await worker.terminate();

        const confidentWords = (words || []).filter(w => w.confidence > 75).slice(0, 30);
        if (confidentWords.length > 0) {
          textMap = confidentWords.map(w => {
            const centerX = Math.floor((w.bbox.x0 + w.bbox.x1) / 2);
            const centerY = Math.floor((w.bbox.y0 + w.bbox.y1) / 2);
            return `- [${w.text}] X:${centerX}, Y:${centerY}`;
          }).join('\n');
        }
      } catch (ocrErr) {
        textMap = `[OCR Text Bounding extraction skipped: ${ocrErr.message}]`;
      }

      // Route notification to mobile app (`AgentScreen.kt`)

      return {
        success: true,
        output: JSON.stringify({
          status: 'Visual inspection frame captured cleanly inside workspace buffer',
          target_device: target,
          verification_prompt: prompt,
          filepath: destPath,
          workspace_boundary_safe: true,
          detected_spatial_elements: textMap || 'No confident OCR text tokens detected.'
        }, null, 2)
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
