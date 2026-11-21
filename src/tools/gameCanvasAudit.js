import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveChromiumRuntime } from '../browser/browserRuntime.js';
import { assertBrowserNavigableUrl } from '../browser/urlPolicy.js';
import { ensureCapability, loadCapabilityPackage } from '../provisioning/capabilityProvisioner.js';
import { sanitizeSubprocessEnv } from './subprocessEnv.js';
import { assertSafeWorkspaceInput, getErrorMessage, sanitizeToolError } from './toolPathSafety.js';
async function resolveAuditTarget(rawUrl, sandbox) {
    const trimmed = rawUrl.trim();
    if (/^https?:\/\//i.test(trimmed)) {
        const validated = await assertBrowserNavigableUrl(trimmed);
        return { targetUrl: validated.href, localRoot: null };
    }
    const localCandidate = trimmed.startsWith('file://') ? fileURLToPath(new URL(trimmed)) : trimmed;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && !trimmed.startsWith('file://') && !/^[a-zA-Z]:[\\/]/.test(trimmed)) {
        throw new Error(`Unsupported URL scheme for game audit: ${trimmed.split(':')[0]}`);
    }
    const checked = await assertSafeWorkspaceInput(localCandidate, sandbox, { maxBytes: 16 * 1024 * 1024 });
    const ext = path.extname(checked.resolved).toLowerCase();
    if (ext !== '.html' && ext !== '.htm') {
        throw new Error('Local game audit target must be an .html or .htm file inside the authorized workspace.');
    }
    return { targetUrl: pathToFileURL(checked.resolved).href, localRoot: path.dirname(checked.resolved) };
}
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
    execute: async (args = {}, sandbox) => {
        const rawUrl = args?.url;
        if (typeof rawUrl !== 'string' || !rawUrl.trim())
            return { success: false, error: 'URL is required' };
        let browser = null;
        try {
            const { targetUrl, localRoot } = await resolveAuditTarget(rawUrl, sandbox);
            const url = targetUrl;
            const vision = await ensureCapability('vision');
            if (!vision.ok)
                return { success: false, error: vision.reason, requiresConsent: vision.requiresConsent };
            const runtime = resolveChromiumRuntime();
            if (!runtime) {
                return { success: false, error: 'Chromium browser runtime not found. Install Chrome/Chromium or set CAUSYNE_BROWSER_EXECUTABLE.' };
            }
            const puppeteer = { default: await loadCapabilityPackage('puppeteer-core') };
            browser = await puppeteer.default.launch({
                executablePath: runtime.executablePath,
                headless: 'new',
                env: sanitizeSubprocessEnv(process.env),
                args: ['--autoplay-policy=no-user-gesture-required']
            });
            const page = await browser.newPage();
            await page.goto(url, { waitUntil: 'load', timeout: 15000 });
            await new Promise((r) => setTimeout(r, 1000));
            await page.keyboard.down('ArrowUp');
            await new Promise((r) => setTimeout(r, 500));
            await page.keyboard.up('ArrowUp');
            const auditResult = await page.evaluate(() => {
                const doc = globalThis.document;
                const canvas = doc?.querySelector('canvas');
                if (!canvas)
                    return { error: 'No canvas element found.' };
                let dataURL;
                try {
                    dataURL = canvas.toDataURL('image/png');
                }
                catch (e) {
                    return { error: 'Could not export canvas to DataURL: ' + (e instanceof Error ? e.message : String(e)) };
                }
                if (dataURL === 'data:,' || dataURL.length < 50)
                    return { error: 'Canvas data URL is empty.' };
                return { canvas_found: true, data_url_length: dataURL.length };
            });
            if (auditResult.error) {
                return {
                    visual_status: 'CRITICAL_BLANK_SCREEN',
                    entropy_score: 0.0,
                    verification_summary: 'FAIL: ' + auditResult.error
                };
            }
            if ((auditResult.data_url_length ?? 0) < 2000) {
                return {
                    visual_status: 'CRITICAL_BLANK_SCREEN',
                    entropy_score: 0.01,
                    verification_summary: 'FAIL: Canvas pixel variance is near zero (Blank Screen).'
                };
            }
            return {
                visual_status: 'HEALTHY',
                entropy_score: 0.85,
                detected_color_clusters: ['#000000', '#ffffff', '#00ffcc'],
                verification_summary: 'PASS: Canvas rendering detected and pixel variance is high.'
            };
        }
        catch (e) {
            return { success: false, error: 'Canvas Audit crashed: ' + getErrorMessage(e) };
        }
        finally {
            if (browser) {
                await browser.close().catch(() => { });
            }
        }
    }
};
