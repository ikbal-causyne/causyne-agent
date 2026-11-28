import type { WorkspaceFileHrefInfo } from './types.js';

export function isSafeHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export function parseLoopbackUrl(raw: string): string | null {
  try {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return null;
    const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : (`http://${trimmed}`);
    const u = new URL(normalized);
    const host = u.hostname.toLowerCase();
    if (u.protocol !== 'http:') return null;
    if (host !== '127.0.0.1' && host !== 'localhost') return null;
    return u.href;
  } catch {
    return null;
  }
}

export function extractLoopbackUrls(text: string): string[] {
  const found: string[] = [];
  const matches = String(text || '').match(/http:\/\/(?:127\.0\.0\.1|localhost):\d{2,5}(?:\/[^\s)\[\]'"`<>]*)?/gi) || [];
  for (const m of matches) {
    const cleaned = m.replace(/[.,;:!?\])]+$/g, '');
    const valid = parseLoopbackUrl(cleaned);
    if (valid && !found.includes(valid)) found.push(valid);
  }
  return found.slice(0, 3);
}

function normalizePathSlashes(raw: string): string {
  return raw.replace(/\\/g, '/');
}

function normalizeDrivePrefix(raw: string): string {
  // file:///C:/foo -> C:/foo (Windows compatibility alongside POSIX /Users/...)
  const winFile = /^\/([a-zA-Z]:\/.*)$/.exec(raw);
  return winFile?.[1] ? winFile[1] : raw;
}

export function parseWorkspaceFileHref(rawHref: string, workspaceRoot: string): WorkspaceFileHrefInfo | null {
  const trimmed = String(rawHref || '').trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const isFileScheme = trimmed.toLowerCase().startsWith('file://');
  // Reject every non-file URI scheme (javascript:, data:, vbscript:, mailto:, http:, etc.)
  if (!isFileScheme && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return null;

  let body = isFileScheme ? trimmed.slice(7) : trimmed;
  let lineBadge = '';
  const hashIdx = body.indexOf('#');
  if (hashIdx >= 0) {
    const frag = body.slice(hashIdx + 1);
    body = body.slice(0, hashIdx);
    const lm = frag.match(/^L(\d+)(?:-L?(\d+))?$/i);
    if (lm?.[1]) lineBadge = lm[2] ? (`:${lm[1]}-${lm[2]}`) : (`:${lm[1]}`);
  }
  const qIdx = body.indexOf('?');
  if (qIdx >= 0) body = body.slice(0, qIdx);
  try { body = decodeURIComponent(body); } catch { /* keep raw */ }

  // Reject control characters or NUL bytes
  for (let i = 0; i < body.length; i += 1) {
    const code = body.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }

  const wsRoot = normalizePathSlashes(String(workspaceRoot || '')).replace(/\/+$/, '');
  const normPrivate = (p: string): string => p.replace(/^\/private(?=\/(?:var|tmp)(?:\/|$))/, '');

  if (isFileScheme) {
    const bodyClean = normalizeDrivePrefix(normalizePathSlashes(body));
    const bodyNorm = normPrivate(bodyClean);
    const wsNorm = normPrivate(wsRoot);
    let relPath: string | null = null;
    if (wsNorm) {
      const isWin = /^[a-zA-Z]:\//.test(wsNorm);
      const cmpBody = isWin ? bodyNorm.toLowerCase() : bodyNorm;
      const cmpWs = isWin ? wsNorm.toLowerCase() : wsNorm;
      if (cmpBody.startsWith(`${cmpWs}/`)) {
        relPath = bodyNorm.slice(wsNorm.length + 1);
      }
    }
    const display = relPath || bodyClean.split('/').slice(-2).join('/') || bodyClean;
    return { fullPath: bodyClean, relPath, display, lineBadge };
  }

  // Safe relative workspace file link (e.g. "package.json", "./src/index.ts", "docs/guide.md#L12")
  const relClean = normalizePathSlashes(body).replace(/^\.\//, '');
  if (!relClean || relClean.startsWith('/') || relClean.endsWith('/')) return null;
  if (/^[a-zA-Z]:/.test(relClean)) return null;
  const segments = relClean.split('/');
  if (segments.some((seg) => !seg || seg === '.' || seg === '..')) return null;
  // Require a recognizable file name (has extension or dotfile/Makefile-style relative path)
  const leaf = segments[segments.length - 1] || '';
  if (!leaf.includes('.') && segments.length < 2) return null;

  const fullPath = wsRoot ? `${wsRoot}/${relClean}` : relClean;
  return { fullPath, relPath: relClean, display: relClean, lineBadge };
}

export function isHtmlOrSvgPath(relPath: string): boolean {
  const p = String(relPath || '').toLowerCase();
  return p.endsWith('.html') || p.endsWith('.htm') || p.endsWith('.svg');
}

export function artifactBadgeFor(relPath: string, lang: string): { tag: string; label: string } {
  const p = String(relPath || '').toLowerCase();
  if (p.endsWith('.idoc.md')) return { tag: 'IDOC', label: 'idoc Document' };
  if (p.endsWith('.html') || p.endsWith('.htm') || lang === 'html') return { tag: 'HTML', label: 'Interactive HTML' };
  if (p.endsWith('.svg') || lang === 'svg') return { tag: 'SVG', label: 'SVG Graphic' };
  if (p.endsWith('.md') || lang === 'markdown' || lang === 'md') return { tag: 'DOC', label: 'Markdown Document' };
  const ext = p.includes('.')
    ? (p.split('.').pop() || '').toUpperCase().slice(0, 4)
    : (lang ? lang.toUpperCase().slice(0, 4) : 'CODE');
  return { tag: ext || 'CODE', label: 'Source File' };
}

export function isSafeBillingUrl(raw: string): boolean {
  try {
    const u = new URL(String(raw || ''));
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
    const h = u.hostname.toLowerCase();
    return h === 'paddle.com'
      || h.endsWith('.paddle.com')
      || h === 'dodopayments.com'
      || h.endsWith('.dodopayments.com')
      || h === 'causyne.com'
      || h.endsWith('.causyne.com');
  } catch {
    return false;
  }
}
