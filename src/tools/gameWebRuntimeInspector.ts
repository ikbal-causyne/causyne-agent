import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveChromiumRuntime } from '../browser/browserRuntime.js';
import { assertBrowserNavigableUrl } from '../browser/urlPolicy.js';
import { ensureCapability, loadCapabilityPackage } from '../provisioning/capabilityProvisioner.js';
import { sanitizeSubprocessEnv } from './subprocessEnv.js';
import {
  assertSafeWorkspaceInput,
  getErrorMessage,
  sanitizeToolError,
  sanitizeToolText,
  type ToolWorkspaceContext
} from './toolPathSafety.js';

async function resolveInspectorTarget(
  rawUrl: string,
  sandbox?: ToolWorkspaceContext
): Promise<{ targetUrl: string; localRoot: string | null }> {
  const trimmed = rawUrl.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const validated = await assertBrowserNavigableUrl(trimmed);
    return { targetUrl: validated.href, localRoot: null };
  }
  const localCandidate = trimmed.startsWith('file://') ? fileURLToPath(new URL(trimmed)) : trimmed;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && !trimmed.startsWith('file://') && !/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    throw new Error(`Unsupported URL scheme for runtime inspector: ${trimmed.split(':')[0]}`);
  }
  const checked = await assertSafeWorkspaceInput(localCandidate, sandbox, { maxBytes: 16 * 1024 * 1024 });
  const ext = path.extname(checked.resolved).toLowerCase();
  if (ext !== '.html' && ext !== '.htm') {
    throw new Error('Local runtime inspection target must be an .html or .htm file inside the authorized workspace.');
  }
  return { targetUrl: pathToFileURL(checked.resolved).href, localRoot: path.dirname(checked.resolved) };
}

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
  execute: async (args: GameWebRuntimeInspectorArgs = {}, sandbox?: ToolWorkspaceContext): Promise<Record<string, unknown>> => {
    const rawUrl = args?.url;
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) return { success: false, error: 'URL is required' };

    let browser: { newPage(): Promise<any>; close(): Promise<void> } | null = null;
    try {
      const { targetUrl, localRoot } = await resolveInspectorTarget(rawUrl, sandbox);
      const url = targetUrl;
      const vision = await ensureCapability('vision');
      if (!vision.ok) return { success: false, error: vision.reason, requiresConsent: vision.requiresConsent };
      const runtime = resolveChromiumRuntime();
      if (!runtime) {
        return { success: false, error: 'Chromium browser runtime not found. Install Chrome/Chromium or set CAUSYNE_BROWSER_EXECUTABLE.' };
      }
      const puppeteer = { default: await loadCapabilityPackage('puppeteer-core') as { launch(opts: Record<string, unknown>): Promise<any> } };

      browser = await puppeteer.default.launch({
        executablePath: runtime.executablePath,
        headless: 'new',
        env: sanitizeSubprocessEnv(process.env),
        args: ['--autoplay-policy=no-user-gesture-required']
      });

      const page = await browser!.newPage();
      if (typeof page.setRequestInterception === 'function') {
        await page.setRequestInterception(true);
        page.on('request', async (req: { url(): string; continue(): Promise<void>; abort(): Promise<void> }) => {
          try {
            const reqUrl = String(req.url() || '');
            if (reqUrl.startsWith('data:') || reqUrl.startsWith('blob:')) {
              await req.continue();
              return;
            }
            if (reqUrl.startsWith('file://')) {
              const reqPath = path.resolve(fileURLToPath(new URL(reqUrl)));
              if (localRoot && (reqPath === localRoot || reqPath.startsWith(localRoot + path.sep))) {
                await req.continue();
                return;
              }
              await req.abort();
              return;
            }
            await assertBrowserNavigableUrl(reqUrl);
            await req.continue();
          } catch {
            await req.abort().catch(() => {});
          }
        });
      }
      if (sandbox?.signal?.aborted) {
        return { success: false, error: 'Runtime inspection aborted' };
      }
      const errors: string[] = [];
      page.on('pageerror', (err: unknown) => {
        if (errors.length < 100) errors.push(sanitizeToolText(err, 512));
      });
      page.on('console', (msg: { type(): string; text(): string }) => {
        if (msg.type() === 'error' && errors.length < 100) {
          errors.push(sanitizeToolText(msg.text(), 512));
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
      return { success: false, error: 'Runtime Inspector crashed: ' + sanitizeToolError(e) };
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  }
};
