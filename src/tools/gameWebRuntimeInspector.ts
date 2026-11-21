import { ensureCapability, loadCapabilityPackage } from '../provisioning/capabilityProvisioner.js';
import { getErrorMessage, type ToolWorkspaceContext } from './toolPathSafety.js';

export interface GameWebRuntimeInspectorArgs {
  url?: string | undefined;
}

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
  execute: async (args: GameWebRuntimeInspectorArgs = {}, _sandbox?: ToolWorkspaceContext): Promise<Record<string, unknown>> => {
    let url = args?.url;
    if (typeof url !== 'string' || !url.trim()) return { success: false, error: 'URL is required' };
    url = url.trim();
    if (url.startsWith('/')) {
      url = 'file://' + url;
    }

    let browser: { newPage(): Promise<any>; close(): Promise<void> } | null = null;
    try {
      const vision = await ensureCapability('vision');
      if (!vision.ok) return { success: false, error: vision.reason, requiresConsent: vision.requiresConsent };
      const puppeteer = { default: await loadCapabilityPackage('puppeteer-core') as { launch(opts: Record<string, unknown>): Promise<any> } };

      browser = await puppeteer.default.launch({
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: 'new',
        args: ['--autoplay-policy=no-user-gesture-required']
      });

      const page = await browser!.newPage();
      const errors: string[] = [];
      page.on('pageerror', (err: unknown) => {
        if (errors.length < 100) errors.push(String(err).slice(0, 512));
      });
      page.on('console', (msg: { type(): string; text(): string }) => {
        if (msg.type() === 'error' && errors.length < 100) {
          errors.push(String(msg.text()).slice(0, 512));
        }
      });

      await page.goto(url, { waitUntil: 'load', timeout: 15000 }).catch((e: unknown) => {
        if (errors.length < 100) errors.push('Goto timeout or error: ' + getErrorMessage(e));
      });

      const fpsResult: number = await page.evaluate(() => {
        return new Promise<number>((resolve) => {
          let frames = 0;
          const startTime = performance.now();
          let settled = false;
          const finish = (fps: number): void => {
            if (settled) return;
            settled = true;
            resolve(fps);
          };
          setTimeout(() => finish(frames / 3), 4500);
          const raf = (globalThis as any).requestAnimationFrame as ((cb: () => void) => void) | undefined;
          const loop = (): void => {
            if (settled) return;
            frames++;
            if (performance.now() - startTime < 3000 && typeof raf === 'function') {
              raf(loop);
            } else {
              finish(frames / 3);
            }
          };
          if (typeof raf === 'function') {
            raf(loop);
          } else {
            finish(0);
          }
        });
      }).catch((e: unknown) => {
        if (errors.length < 100) errors.push('FPS Evaluate error: ' + getErrorMessage(e));
        return 0;
      });

      const status = (errors.length === 0 && fpsResult >= 30) ? 'HEALTHY' : 'UNHEALTHY';
      return {
        status,
        mean_fps: Math.round(fpsResult * 10) / 10,
        console_errors: errors
      };
    } catch (e: unknown) {
      return { success: false, error: 'Runtime Inspector crashed: ' + getErrorMessage(e) };
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  }
};
