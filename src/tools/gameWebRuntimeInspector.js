import util from 'util';
import path from 'path';
import { ensureCapability, loadCapabilityPackage } from '../provisioning/capabilityProvisioner.js';

export const gameWebRuntimeInspector = {
  schema: {
    name: 'game_web_runtime_inspector',
    description: 'Runs a headless Chromium quality gate to verify game runtime stability. Checks for JS exceptions and FPS. Mandatory in Stage 7 of the Sovereign Game Cascade.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL or local file path to the HTML game.'
        }
      },
      required: ['url']
    }
  },
  execute: async (args) => {
    let { url } = args;
    if (!url) return { success: false, error: 'URL is required' };
    
    if (url.startsWith('/')) {
        url = 'file://' + url;
    }

    try {
      const vision = await ensureCapability('vision');
      if (!vision.ok) return { success: false, error: vision.reason, requiresConsent: vision.requiresConsent };
      // loadCapabilityPackage already unwraps a default export; this file uses
      // the namespace shape below, so keep it wrapped.
      const puppeteer = { default: await loadCapabilityPackage('puppeteer-core') };

      const browser = await puppeteer.default.launch({
          executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          headless: 'new',
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--autoplay-policy=no-user-gesture-required']
      });

      const page = await browser.newPage();
      
      const errors = [];
      page.on('pageerror', err => {
          errors.push(err.toString());
      });
      page.on('console', msg => {
          if (msg.type() === 'error') {
              errors.push(msg.text());
          }
      });

      await page.goto(url, { waitUntil: 'load', timeout: 15000 }).catch(e => {
          errors.push("Goto timeout or error: " + e.message);
      });

      // Inject FPS counter
      const fpsResult = await page.evaluate(() => {
          return new Promise((resolve) => {
              let frames = 0;
              let startTime = performance.now();
              const loop = () => {
                  frames++;
                  if (performance.now() - startTime < 3000) {
                      requestAnimationFrame(loop);
                  } else {
                      resolve(frames / 3); // Average FPS over 3 seconds
                  }
              };
              requestAnimationFrame(loop);
          });
      }).catch(e => {
          errors.push("FPS Evaluate error: " + e.message);
          return 0;
      });

      await browser.close();

      const status = (errors.length === 0 && fpsResult >= 30) ? 'HEALTHY' : 'UNHEALTHY';

      return {
          status: status,
          mean_fps: Math.round(fpsResult * 10) / 10,
          console_errors: errors
      };

    } catch (e) {
        return { success: false, error: 'Runtime Inspector crashed: ' + e.message };
    }
  }
};
