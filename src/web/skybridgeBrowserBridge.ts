/**
 * Causyne Skybridge — Shared Agent + Human Browser & Explicit Local Chrome CDP Bridge
 *
 * Zero-malware architecture:
 *   - Operates ONLY the shared workspace-scoped `CausyneBrowser` instance.
 *   - Connects to a user's local Chrome/Brave/Edge ONLY via explicit loopback
 *     DevTools Protocol (`http://127.0.0.1:<port>`) when the user requests it.
 *   - NEVER reads, copies, or decrypts Chrome's disk SQLite databases or OS
 *     Keychain Safe Storage keys.
 *   - Supports explicit user-initiated import of exported Bookmarks HTML or
 *     Playwright `storageState.json` cookies into the workspace browser profile.
 */

import {
  causyneBrowser,
  type BrowserCookieRecord,
  type LiveBrowserFrame
} from '../browser/causyneBrowser.js';
import { assertBrowserNavigableUrl } from '../browser/urlPolicy.js';

export interface LocalCdpTabInfo {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string | undefined;
}

export interface ImportedBrowserPayloadSummary {
  importedCookies: number;
  importedUrls: string[];
  openedUrl: string | null;
}

const CDP_TIMEOUT_MS = 4500;
const MAX_CDP_TABS = 40;
const MAX_IMPORT_URLS = 25;

export function parseValidatedCdpPort(rawPort: unknown): number {
  const parsed = Number.parseInt(String(rawPort ?? '9222'), 10);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
    throw new Error('CDP port must be an integer between 1024 and 65535.');
  }
  return parsed;
}

export async function discoverLocalCdpTabs(rawPort: unknown = 9222): Promise<{
  port: number;
  tabs: LocalCdpTabInfo[];
}> {
  const port = parseValidatedCdpPort(rawPort);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CDP_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    if (!res.ok) {
      throw new Error(`Local browser CDP returned HTTP ${res.status}.`);
    }
    const raw = (await res.json()) as unknown;
    if (!Array.isArray(raw)) return { port, tabs: [] };
    const tabs: LocalCdpTabInfo[] = [];
    for (const item of raw) {
      if (tabs.length >= MAX_CDP_TABS) break;
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      if (rec.type !== 'page') continue;
      const url = typeof rec.url === 'string' ? rec.url.trim() : '';
      if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) continue;
      const id = typeof rec.id === 'string' ? rec.id : '';
      if (!id) continue;
      const title = typeof rec.title === 'string' && rec.title.trim() ? rec.title.trim() : url;
      const wsUrl = typeof rec.webSocketDebuggerUrl === 'string' ? rec.webSocketDebuggerUrl : undefined;
      tabs.push({ id, title: title.slice(0, 140), url, ...(wsUrl ? { webSocketDebuggerUrl: wsUrl } : {}) });
    }
    return { port, tabs };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSingleTabCdpCookies(wsDebuggerUrl: string, targetUrl: string): Promise<BrowserCookieRecord[]> {
  let parsedWs: URL;
  try {
    parsedWs = new URL(wsDebuggerUrl);
  } catch {
    return [];
  }
  const host = parsedWs.hostname.toLowerCase();
  if ((parsedWs.protocol !== 'ws:' && parsedWs.protocol !== 'wss:') || (host !== '127.0.0.1' && host !== 'localhost')) {
    throw new Error('Refusing non-loopback CDP WebSocket endpoint.');
  }

  const WebSocketCtor = globalThis.WebSocket;
  if (typeof WebSocketCtor !== 'function') {
    return [];
  }

  return new Promise<BrowserCookieRecord[]>((resolve, reject) => {
    const ws = new WebSocketCtor(parsedWs.href);
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error('Timed out reading selected tab session via loopback CDP.'));
    }, CDP_TIMEOUT_MS);

    const finish = (cookies: BrowserCookieRecord[], err?: Error): void => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve(cookies);
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Network.getCookies',
        params: { urls: [targetUrl] }
      }));
    };

    ws.onerror = () => finish([], new Error('Could not open loopback CDP WebSocket to selected tab.'));

    ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(String(event.data || '')) as {
          id?: number;
          result?: { cookies?: Array<Record<string, unknown>> };
          error?: { message?: string };
        };
        if (msg.id !== 1) return;
        if (msg.error) {
          finish([], new Error('CDP rejected Network.getCookies for selected tab.'));
          return;
        }
        const rawList = Array.isArray(msg.result?.cookies) ? msg.result.cookies : [];
        const cookies: BrowserCookieRecord[] = [];
        for (const c of rawList) {
          if (typeof c.name !== 'string' || typeof c.value !== 'string' || typeof c.domain !== 'string') continue;
          const sameSite = c.sameSite === 'Strict' || c.sameSite === 'Lax' || c.sameSite === 'None'
            ? c.sameSite
            : undefined;
          cookies.push({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: typeof c.path === 'string' ? c.path : '/',
            ...(typeof c.expires === 'number' && Number.isFinite(c.expires) && c.expires > 0 ? { expires: c.expires } : {}),
            ...(typeof c.httpOnly === 'boolean' ? { httpOnly: c.httpOnly } : {}),
            ...(typeof c.secure === 'boolean' ? { secure: c.secure } : {}),
            ...(sameSite ? { sameSite } : {})
          });
        }
        finish(cookies);
      } catch {
        finish([]);
      }
    };
  });
}

export async function syncLocalCdpTabToCausyne(options: {
  workspaceRoot: string;
  port: unknown;
  targetId: string;
  includeCookies: boolean;
}): Promise<{ frame: LiveBrowserFrame; importedCookies: number; syncedUrl: string }> {
  const { tabs } = await discoverLocalCdpTabs(options.port);
  const selected = tabs.find((t) => t.id === options.targetId);
  if (!selected) {
    throw new Error('Selected local browser tab was not found. Refresh tab list and retry.');
  }
  const validated = await assertBrowserNavigableUrl(selected.url);
  const browser = causyneBrowser({ workspace: options.workspaceRoot });
  let importedCookies = 0;

  if (options.includeCookies && selected.webSocketDebuggerUrl) {
    const cookies = await fetchSingleTabCdpCookies(selected.webSocketDebuggerUrl, validated.href);
    if (cookies.length > 0) {
      const res = await browser.importCookies(cookies);
      importedCookies = res.imported;
    }
  }

  await browser.run([{ type: 'goto', url: validated.href }], { workspace: options.workspaceRoot });
  const frame = await browser.captureLiveFrame({ ensureStarted: true });
  return { frame, importedCookies, syncedUrl: validated.href };
}

/**
 * Extracts http(s) URLs from a user-supplied bookmarks export or plain URL list
 * using linear scanning (zero catastrophic regexes, zero HTML injection).
 */
export function extractExplicitBookmarkUrls(rawText: string): string[] {
  const text = String(rawText || '').slice(0, 256 * 1024);
  const found: string[] = [];
  const seen = new Set<string>();

  let pos = 0;
  while (pos < text.length && found.length < MAX_IMPORT_URLS) {
    const httpIdx = text.indexOf('http://', pos);
    const httpsIdx = text.indexOf('https://', pos);
    let start = -1;
    if (httpIdx >= 0 && httpsIdx >= 0) start = Math.min(httpIdx, httpsIdx);
    else start = Math.max(httpIdx, httpsIdx);
    if (start < 0) break;

    let end = start;
    while (end < text.length) {
      const ch = text[end]!;
      if (ch === '"' || ch === "'" || ch === '<' || ch === '>' || ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        break;
      }
      end += 1;
    }
    const candidate = text.slice(start, end).trim();
    pos = end + 1;
    try {
      const parsed = new URL(candidate);
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !seen.has(parsed.href)) {
        seen.add(parsed.href);
        found.push(parsed.href);
      }
    } catch {
      // ignore malformed URL token
    }
  }
  return found;
}

export async function importExplicitUserBrowserData(options: {
  workspaceRoot: string;
  rawText: string;
  openFirstUrl?: boolean | undefined;
}): Promise<ImportedBrowserPayloadSummary> {
  const raw = String(options.rawText || '').trim();
  if (!raw) {
    throw new Error('Provide exported storageState JSON, cookies JSON, or bookmarks/URLs to import.');
  }
  const browser = causyneBrowser({ workspace: options.workspaceRoot });
  let importedCookies = 0;
  let importedUrls: string[] = [];
  let openedUrl: string | null = null;

  if (raw.startsWith('{') || raw.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Invalid JSON format. Provide valid storageState JSON, cookies array, or URL list.');
    }
    const rawCookies: unknown[] = Array.isArray(parsed)
      ? parsed
      : (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).cookies))
        ? ((parsed as Record<string, unknown>).cookies as unknown[])
        : [];
    if (rawCookies.length > 0) {
      const res = await browser.importCookies(rawCookies as BrowserCookieRecord[]);
      importedCookies = res.imported;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const origins = (parsed as Record<string, unknown>).origins;
      if (Array.isArray(origins)) {
        for (const o of origins) {
          if (o && typeof o === 'object' && typeof (o as Record<string, unknown>).origin === 'string') {
            const candidate = String((o as Record<string, unknown>).origin);
            if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
              importedUrls.push(candidate);
            }
          }
        }
      }
    }
  } else {
    importedUrls = extractExplicitBookmarkUrls(raw);
  }

  if (options.openFirstUrl !== false && importedUrls.length > 0) {
    const validated = await assertBrowserNavigableUrl(importedUrls[0]!);
    await browser.run([{ type: 'goto', url: validated.href }], { workspace: options.workspaceRoot });
    openedUrl = validated.href;
  }

  return { importedCookies, importedUrls, openedUrl };
}
