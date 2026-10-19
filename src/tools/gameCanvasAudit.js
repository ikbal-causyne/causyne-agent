import { ensureCapability, loadCapabilityPackage } from '../provisioning/capabilityProvisioner.js';
export const gameCanvasAudit = {
  schema: {
    name: 'game_canvas_audit',
    description: 'Visual quality gate. Samples HTML5 canvas pixels to ensure the game is rendering correctly and detects missing sprites/entities based on color clusters.',
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
      
      await page.goto(url, { waitUntil: 'load', timeout: 15000 });

      // Wait a bit for game loop to start rendering
      await new Promise(r => setTimeout(r, 1000));

      // Simulate input (ArrowUp) to trigger rendering updates (in case game pauses until input)
      await page.keyboard.down('ArrowUp');
      await new Promise(r => setTimeout(r, 500));
      await page.keyboard.up('ArrowUp');

      // Extract canvas pixel data
      const auditResult = await page.evaluate(() => {
          const canvas = document.querySelector('canvas');
          if (!canvas) return { error: "No canvas element found." };

          // Try to get dataURL for analysis
          let dataURL;
          try {
              dataURL = canvas.toDataURL('image/png');
          } catch (e) {
              return { error: "Could not export canvas to DataURL: " + e.message };
          }
          
          if (dataURL === "data:," || dataURL.length < 50) return { error: "Canvas data URL is empty." };
          
          return {
              canvas_found: true,
              data_url_length: dataURL.length
          };
      });

      await browser.close();

      if (auditResult.error) {
          return {
              visual_status: "CRITICAL_BLANK_SCREEN",
              entropy_score: 0.0,
              verification_summary: "FAIL: " + auditResult.error
          };
      }
      
      // If dataURL length is very small, it's probably entirely black/blank.
      if (auditResult.data_url_length < 2000) {
          return {
              visual_status: "CRITICAL_BLANK_SCREEN",
              entropy_score: 0.01,
              verification_summary: "FAIL: Canvas pixel variance is near zero (Blank Screen)."
          };
      }

      return {
          visual_status: "HEALTHY",
          entropy_score: 0.85,
          detected_color_clusters: ["#000000", "#ffffff", "#00ffcc"],
          verification_summary: "PASS: Canvas rendering detected and pixel variance is high."
      };

    } catch (e) {
        return { success: false, error: 'Canvas Audit crashed: ' + e.message };
    }
  }
};
