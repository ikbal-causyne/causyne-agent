import { spawn } from 'node:child_process';
import { sidebarVisible, sessionMainWidth } from './sessionSidebar.js';
import { visibleWidth } from './text.js';
import type { MessageMarker } from './messageInteraction.js';

export interface DetectedLink {
  url: string;
  label: string;
  startCol: number;
  endCol: number;
  row: number;
  isOsc8: boolean;
}

export interface SmartLinkSurface {
  width: number;
  env?: { CAUSYNE_SIDEBAR?: string };
  homeInfo?: unknown;
  out: { rows?: number };
  stage: { height: number; reserved: boolean };
  viewport: { height?: number; width?: number; viewHeight?: number; viewWidth?: number; scrollTop: number };
  transcript: { flatten(width: number): { rows: string[]; markers: MessageMarker[] } };
  turnRailLayout?: { turns?: unknown[] } | null;
}

const KNOWN_WEB_TLDS = new Set([
  'com', 'org', 'net', 'io', 'dev', 'app', 'ai', 'co', 'edu', 'gov',
  'me', 'sh', 'xyz', 'tech', 'cloud', 'gg', 'tv', 'info', 'biz', 'page',
  'site', 'online', 'link', 'live', 'studio', 'design', 'so', 'to', 'fm',
  'id', 'uk', 'de', 'fr', 'jp', 'kr', 'au', 'ca', 'us', 'eu', 'in', 'sg'
]);

const CODE_FILE_EXTENSIONS = new Set([
  'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java',
  'c', 'cpp', 'h', 'hpp', 'cs', 'php', 'swift', 'kt', 'scala', 'lua',
  'json', 'yaml', 'yml', 'toml', 'xml', 'ini', 'env', 'lock', 'md', 'txt',
  'css', 'scss', 'less', 'vue', 'svelte', 'astro', 'sql', 'graphql', 'proto',
  'wasm', 'map', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'mp4',
  'mov', 'mp3', 'wav', 'ogg', 'pdf', 'zip', 'tar', 'gz', 'tgz'
]);

const KNOWN_HOST_SUFFIXES = [
  '.vercel.app',
  '.netlify.app',
  '.pages.dev',
  '.github.io',
  '.fly.dev',
  '.railway.app',
  '.render.com',
  '.onrender.com',
  '.herokuapp.com',
  '.workers.dev',
  '.web.app',
  '.firebaseapp.com',
  '.supabase.co',
  '.amazonaws.com',
  '.cloudfront.net',
  'vercel.com',
  'github.com',
  'gitlab.com',
  'npmjs.com',
  'pypi.org',
  'crates.io',
  'localhost'
];

function stripTrailingPunctuation(raw: string): { clean: string; trimmedChars: number } {
  let clean = raw;
  let trimmedChars = 0;
  while (clean.length > 0) {
    const last = clean[clean.length - 1]!;
    if (/[.,;:!?'"`\]>]/.test(last)) {
      clean = clean.slice(0, -1);
      trimmedChars++;
      continue;
    }
    if (last === ')') {
      const opens = (clean.match(/\(/g) || []).length;
      const closes = (clean.match(/\)/g) || []).length;
      if (closes > opens) {
        clean = clean.slice(0, -1);
        trimmedChars++;
        continue;
      }
    }
    break;
  }
  return { clean, trimmedChars };
}

function isLikelyBareWebDomain(token: string): boolean {
  const withoutEllipsis = token.replace(/(?:…|\.{2,})+$/, '');
  const slashIdx = withoutEllipsis.indexOf('/');
  const hostPort = (slashIdx >= 0 ? withoutEllipsis.slice(0, slashIdx) : withoutEllipsis).toLowerCase();
  const pathPart = slashIdx >= 0 ? withoutEllipsis.slice(slashIdx) : '';

  if (/^(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}$/.test(hostPort)) {
    return true;
  }

  const host = hostPort.replace(/:\d{2,5}$/, '');
  if (!host.includes('.') || host.startsWith('.') || host.endsWith('.')) return false;

  for (const suffix of KNOWN_HOST_SUFFIXES) {
    if (host === suffix || host.endsWith(suffix)) return true;
  }

  const parts = host.split('.');
  if (parts.length < 2) return false;
  const tld = parts[parts.length - 1]!;
  if (!KNOWN_WEB_TLDS.has(tld)) return false;

  if (!pathPart && CODE_FILE_EXTENSIONS.has(tld) && parts.length === 2) {
    return false;
  }

  if (parts.some(p => !/^[a-z0-9-]+$/i.test(p) || p.startsWith('-') || p.endsWith('-'))) {
    return false;
  }

  return true;
}

export function resolveFullUrlFromMessage(candidate: string, rawMessageText?: string): string {
  const cleaned = candidate.trim();
  const isTruncated = cleaned.endsWith('…') || cleaned.endsWith('...');
  const prefix = cleaned
    .replace(/(?:…|\.{2,})+$/, '')
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '');

  if (rawMessageText && prefix.length >= 4) {
    const urlRegex = /https?:\/\/[^\s<>"'`)\]]+/gi;
    let match: RegExpExecArray | null;
    while ((match = urlRegex.exec(rawMessageText)) !== null) {
      const fullUrl = stripTrailingPunctuation(match[0]).clean;
      const normalizedFull = fullUrl.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
      if (isTruncated) {
        if (normalizedFull.startsWith(prefix)) return fullUrl;
      } else if (normalizedFull === prefix) {
        return fullUrl;
      }
    }
  }

  const withoutEllipsis = cleaned.replace(/(?:…|\.{2,})+$/, '');
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(withoutEllipsis)) {
    return withoutEllipsis;
  }
  if (/^(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}/i.test(withoutEllipsis)) {
    return `http://${withoutEllipsis}`;
  }
  return `https://${withoutEllipsis}`;
}

function findUnclosedOsc8Url(rawRow: string | undefined): string | null {
  if (!rawRow || !rawRow.includes('\x1b]8;')) return null;
  let active: string | null = null;
  const osc8Re = /\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  let match: RegExpExecArray | null;
  while ((match = osc8Re.exec(rawRow)) !== null) {
    const target = match[1] ?? '';
    active = target.length > 0 ? target : null;
  }
  return active;
}

/**
 * Extract all clickable links (both OSC 8 hyperlinks and visible URLs / bare domains)
 * along with their exact visible column intervals `[startCol, endCol]` on a single row.
 */
export function extractRowLinks(
  rawRow: string,
  rowIndex = 0,
  rawMessageText?: string,
  prevRawRow?: string
): DetectedLink[] {
  if (!rawRow) return [];
  const links: DetectedLink[] = [];

  let col = 0;
  let i = 0;
  let activeOsc8Url: string | null = findUnclosedOsc8Url(prevRawRow);
  let osc8StartCol = 0;
  let osc8Label = '';

  const charToColStart: number[] = [];
  const charToColEnd: number[] = [];
  let stripped = '';

  while (i < rawRow.length) {
    if (rawRow.startsWith('\x1b]8;', i)) {
      const rest = rawRow.slice(i + 4);
      const semi = rest.indexOf(';');
      if (semi !== -1) {
        const afterParams = rest.slice(semi + 1);
        const belIdx = afterParams.indexOf('\x07');
        const stIdx = afterParams.indexOf('\x1b\\');
        let endOffset = -1;
        let terminatorLen = 0;
        if (belIdx !== -1 && (stIdx === -1 || belIdx < stIdx)) {
          endOffset = belIdx;
          terminatorLen = 1;
        } else if (stIdx !== -1) {
          endOffset = stIdx;
          terminatorLen = 2;
        }
        if (endOffset !== -1) {
          const urlParam = afterParams.slice(0, endOffset);
          if (urlParam.length > 0) {
            if (activeOsc8Url && col > osc8StartCol) {
              const resolvedPrev = resolveFullUrlFromMessage(
                activeOsc8Url.endsWith('…') ? osc8Label || activeOsc8Url : activeOsc8Url,
                rawMessageText
              );
              links.push({
                url: resolvedPrev,
                label: osc8Label,
                startCol: osc8StartCol,
                endCol: col - 1,
                row: rowIndex,
                isOsc8: true
              });
            }
            activeOsc8Url = urlParam;
            osc8StartCol = col;
            osc8Label = '';
          } else if (activeOsc8Url) {
            if (col > osc8StartCol) {
              const resolved = resolveFullUrlFromMessage(
                activeOsc8Url.endsWith('…') ? osc8Label || activeOsc8Url : activeOsc8Url,
                rawMessageText
              );
              links.push({
                url: resolved,
                label: osc8Label,
                startCol: osc8StartCol,
                endCol: col - 1,
                row: rowIndex,
                isOsc8: true
              });
            }
            activeOsc8Url = null;
            osc8Label = '';
          }
          i += 4 + semi + 1 + endOffset + terminatorLen;
          continue;
        }
      }
    }

    if (rawRow[i] === '\x1b') {
      const csi = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(rawRow.slice(i));
      if (csi) {
        i += csi[0].length;
        continue;
      }
      const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(rawRow.slice(i));
      if (osc) {
        i += osc[0].length;
        continue;
      }
      i++;
      continue;
    }

    const code = rawRow.codePointAt(i)!;
    const ch = String.fromCodePoint(code);
    const w = Math.max(0, visibleWidth(ch));
    charToColStart.push(col);
    charToColEnd.push(w > 0 ? col + w - 1 : col);
    stripped += ch;
    if (activeOsc8Url) osc8Label += ch;
    col += w;
    i += ch.length;
  }

  if (activeOsc8Url && col > osc8StartCol) {
    const resolved = resolveFullUrlFromMessage(
      activeOsc8Url.endsWith('…') ? osc8Label || activeOsc8Url : activeOsc8Url,
      rawMessageText
    );
    links.push({
      url: resolved,
      label: osc8Label,
      startCol: osc8StartCol,
      endCol: col - 1,
      row: rowIndex,
      isOsc8: true
    });
  }

  const tokenRe = /(?:https?:\/\/|file:\/\/)[^\s<>"'`)\]]+|(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}(?:\/[^\s<>"'`)\]]*)?|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,24}(?:\/[^\s<>"'`)\]]*)?/g;
  let tokenMatch: RegExpExecArray | null;
  while ((tokenMatch = tokenRe.exec(stripped)) !== null) {
    const rawToken = tokenMatch[0];
    const { clean } = stripTrailingPunctuation(rawToken);
    if (!clean) continue;

    const isExplicitScheme = /^(?:https?|file):\/\//i.test(clean);
    if (!isExplicitScheme && !isLikelyBareWebDomain(clean)) continue;

    const startCharIdx = Array.from(stripped.slice(0, tokenMatch.index)).length;
    const cleanCodePoints = Array.from(clean).length;
    const endCharIdx = startCharIdx + cleanCodePoints - 1;
    const startCol = charToColStart[startCharIdx];
    const endCol = charToColEnd[endCharIdx];
    if (startCol === undefined || endCol === undefined) continue;

    const overlapsOsc8 = links.some(
      existing => existing.isOsc8 && startCol <= existing.endCol && endCol >= existing.startCol
    );
    if (overlapsOsc8) continue;

    const resolvedUrl = resolveFullUrlFromMessage(clean, rawMessageText);
    links.push({
      url: resolvedUrl,
      label: clean,
      startCol,
      endCol,
      row: rowIndex,
      isOsc8: false
    });
  }

  return links;
}

/**
 * Check if a screen point `(point.x, point.y)` lands on a clickable URL/link in the transcript.
 */
export function detectLinkAtPoint(
  surface: SmartLinkSurface | null,
  point: { x: number; y: number },
  marker?: MessageMarker | null
): DetectedLink | null {
  if (!surface?.stage.reserved || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const surfaceWidth = Number.isFinite(surface.width) ? Math.floor(surface.width) : 0;
  const rawViewW = Number.isFinite(surface.viewport?.viewWidth) ? surface.viewport.viewWidth : surface.viewport?.width;
  const rawViewH = Number.isFinite(surface.viewport?.viewHeight) ? surface.viewport.viewHeight : surface.viewport?.height;
  const viewportWidth = Number.isFinite(rawViewW) ? Math.floor(rawViewW as number) : 0;
  const viewportHeight = Number.isFinite(rawViewH) ? Math.floor(rawViewH as number) : 0;
  const stageHeight = Number.isFinite(surface.stage.height) ? Math.floor(surface.stage.height) : 0;
  if (surfaceWidth <= 0 || viewportWidth <= 0 || viewportHeight <= 0 || stageHeight <= 0) return null;

  const px = Math.floor(point.x);
  const py = Math.floor(point.y);
  const isHome = Boolean(surface.homeInfo);
  const mainWidth = sidebarVisible(surfaceWidth, isHome, surface.env)
    ? sessionMainWidth(surfaceWidth, isHome, surface.env)
    : surfaceWidth;
  const leftGutter = (surface.turnRailLayout?.turns?.length ?? 0) > 0 ? 3 : 0;
  if (px < leftGutter || px >= Math.min(mainWidth, viewportWidth + leftGutter)) return null;

  const outRows = Number.isFinite(surface.out.rows) && (surface.out.rows as number) > 0
    ? Math.floor(surface.out.rows as number)
    : stageHeight;
  const top = Math.max(0, outRows - stageHeight);
  const viewRow = py - top;
  if (viewRow < 0 || viewRow >= viewportHeight) return null;

  const scrollTop = Number.isFinite(surface.viewport.scrollTop) ? Math.max(0, Math.floor(surface.viewport.scrollTop)) : 0;
  const flat = surface.transcript.flatten(viewportWidth);
  const visible = Math.max(0, Math.min(viewportHeight, flat.rows.length - scrollTop));
  const padding = viewportHeight - visible;
  if (viewRow < padding) return null;

  const row = scrollTop + viewRow - padding;
  const rawRow = flat.rows[row];
  if (!rawRow) return null;

  const prevRawRow = row > 0 ? flat.rows[row - 1] : undefined;
  const rawMessageText = marker?.meta?.messageText;
  const links = extractRowLinks(rawRow, row, rawMessageText, prevRawRow);
  if (!links.length) return null;

  const col = px - leftGutter;
  for (const link of links) {
    if (col >= link.startCol && col <= link.endCol) {
      return link;
    }
  }
  return null;
}

let lastOpenedUrl = '';
let lastOpenedAt = 0;

export interface OpenLinkOptions {
  platform?: NodeJS.Platform;
  spawnImpl?: typeof spawn;
  now?: number;
  debounceMs?: number;
}

/**
 * Open an HTTP/HTTPS/file URL in the system default browser or handler without blocking the TUI.
 */
export function openDetectedLink(url: string, options: OpenLinkOptions = {}): boolean {
  if (!url || !/^(?:https?|file):\/\//i.test(url)) return false;

  const now = typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now();
  const debounceMs = typeof options.debounceMs === 'number' && Number.isFinite(options.debounceMs)
    ? Math.max(0, options.debounceMs)
    : 800;
  if (url === lastOpenedUrl && now >= lastOpenedAt && now - lastOpenedAt < debounceMs) {
    return true;
  }

  const platform = options.platform ?? process.platform;
  const spawnFn = options.spawnImpl ?? spawn;

  let command: string;
  let args: string[];
  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    command = 'rundll32.exe';
    args = ['url.dll,FileProtocolHandler', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawnFn(command, args, {
      detached: true,
      stdio: 'ignore',
      shell: false,
      windowsHide: true
    });
    child.on?.('error', () => {
      // Ignore missing browser opener errors on headless hosts.
    });
    child.unref?.();
    lastOpenedUrl = url;
    lastOpenedAt = now;
    return true;
  } catch {
    return false;
  }
}

export function resetLinkOpenDebounceForTests(): void {
  lastOpenedUrl = '';
  lastOpenedAt = 0;
}
