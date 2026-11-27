import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isPhysicalPathAllowed, physicalPath } from '../../agent/workspaceBoundary.js';
import { isIgnoredByCausyneIgnore } from '../../ignoreRules.js';
import { parseUnifiedDiff } from '../../diffReview.js';

export const MAX_FILE_READ_BYTES = 512 * 1024;
export const MAX_FILE_WRITE_BYTES = 2 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 32 * 1024;
export const MAX_ATTACHMENTS = 6;
const MAX_LIST_ENTRIES = 250;
const SKIPPED_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.venv']);

export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function resolveWorkspaceRelativePath(workspaceRoot: string, rawRel: string): string | null {
  if (typeof rawRel !== 'string' || rawRel.includes('\0')) return null;
  const cleaned = rawRel.trim();
  if (!cleaned) return null;
  if (path.isAbsolute(cleaned)) return null;
  const candidate = path.resolve(workspaceRoot, cleaned);
  if (!isPhysicalPathAllowed(candidate, [workspaceRoot], false)) return null;
  return candidate;
}

export function workspaceMatchesSession(sessionWorkspace: string, workspaceRoot: string): boolean {
  if (!sessionWorkspace) return false;
  const resolvedSession = physicalPath(sessionWorkspace);
  return resolvedSession === workspaceRoot || sessionWorkspace === workspaceRoot;
}

export function listWorkspaceEntries(
  workspaceRoot: string,
  relDir: string,
  query = ''
): Array<{ path: string; name: string; type: 'dir' | 'file'; size: number }> {
  const targetDir = relDir ? resolveWorkspaceRelativePath(workspaceRoot, relDir) : workspaceRoot;
  if (!targetDir) throw new Error('Requested directory is outside the locked workspace.');
  const q = query.trim().toLowerCase();
  const entries: Array<{ path: string; name: string; type: 'dir' | 'file'; size: number }> = [];

  const scan = (dir: string, depth: number): void => {
    if (entries.length >= MAX_LIST_ENTRIES) return;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (entries.length >= MAX_LIST_ENTRIES) break;
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory() && SKIPPED_DIRS.has(d.name)) continue;
      const abs = path.join(dir, d.name);
      if (!isPhysicalPathAllowed(abs, [workspaceRoot], false)) continue;
      if (isIgnoredByCausyneIgnore(abs, workspaceRoot, d.isDirectory())) continue;
      const rel = path.relative(workspaceRoot, abs).split(path.sep).join('/');
      const isDir = d.isDirectory();
      let size = 0;
      if (!isDir) {
        try { size = fs.statSync(abs).size; } catch { size = 0; }
      }
      if (!q || rel.toLowerCase().includes(q)) {
        entries.push({ path: rel, name: d.name, type: isDir ? 'dir' : 'file', size });
      }
      if (q && isDir && depth < 3) {
        scan(abs, depth + 1);
      }
    }
  };

  scan(targetDir, 0);
  entries.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'dir' ? -1 : 1));
  return entries;
}

export function buildWorkspacePromptWithAttachments(
  workspaceRoot: string,
  prompt: string,
  rawAttachments: unknown
): { effectivePrompt: string; attachedPaths: string[] } {
  if (!Array.isArray(rawAttachments) || rawAttachments.length === 0) {
    return { effectivePrompt: prompt, attachedPaths: [] };
  }
  const attachedPaths: string[] = [];
  const sections: string[] = [];
  for (const raw of rawAttachments.slice(0, MAX_ATTACHMENTS)) {
    if (typeof raw !== 'string') continue;
    const abs = resolveWorkspaceRelativePath(workspaceRoot, raw);
    if (!abs) continue;
    if (isIgnoredByCausyneIgnore(abs, workspaceRoot, false)) continue;
    try {
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      const buf = fs.readFileSync(abs);
      if (buf.includes(0)) continue;
      const sliced = buf.length > MAX_ATTACHMENT_BYTES ? buf.subarray(0, MAX_ATTACHMENT_BYTES) : buf;
      const rel = path.relative(workspaceRoot, abs).split(path.sep).join('/');
      const truncatedNote = buf.length > MAX_ATTACHMENT_BYTES ? '\n[truncated]' : '';
      attachedPaths.push(rel);
      sections.push(`--- Attached workspace file: ${rel} ---\n${sliced.toString('utf8')}${truncatedNote}`);
    } catch {
      // skip unreadable attachment
    }
  }
  if (sections.length === 0) {
    return { effectivePrompt: prompt, attachedPaths: [] };
  }
  return {
    effectivePrompt: `${sections.join('\n\n')}\n\n${prompt}`,
    attachedPaths
  };
}

export function buildSynthesizedWriteHunk(content: string): {
  additions: number;
  hunks: Array<{ header: string; lines: string[] }>;
} {
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const capped = lines.slice(0, 140).map((ln) => `+${ln}`);
  if (lines.length > 140) capped.push(`+... (${lines.length - 140} more lines)`);
  return {
    additions: lines.length,
    hunks: capped.length > 0
      ? [{ header: `@@ -0,0 +1,${lines.length} @@`, lines: capped }]
      : []
  };
}

export function readLastGitCommitDiffForFile(
  workspaceRoot: string,
  relPath: string
): { additions: number; deletions: number; hunks: Array<{ header: string; lines: string[] }> } | null {
  if (!relPath || relPath.startsWith('-') || relPath.includes('\0')) return null;
  try {
    const raw = execFileSync(
      'git',
      ['log', '-n', '1', '--format=', '--unified=3', '--no-color', '-p', '--', relPath],
      {
        cwd: workspaceRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 256 * 1024,
        timeout: 3000,
        windowsHide: true
      }
    );
    if (!raw || !raw.trim()) return null;
    const parsed = parseUnifiedDiff(raw);
    const first = parsed[0];
    if (!first || first.hunks.length === 0) return null;
    return {
      additions: first.additions,
      deletions: first.deletions,
      hunks: first.hunks.slice(0, 12).map((h) => ({
        header: h.header,
        lines: h.lines.slice(0, 140)
      }))
    };
  } catch {
    return null;
  }
}

const MAX_PACK_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_PACK_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_PACK_ASSETS = 64;

function extractAttributeValue(rawAttrs: string, attrName: string): string | null {
  const lower = rawAttrs.toLowerCase();
  const target = attrName.toLowerCase();
  let idx = 0;
  while (idx < lower.length) {
    const pos = lower.indexOf(target, idx);
    if (pos === -1) return null;
    const prevCh = pos > 0 ? lower[pos - 1]! : ' ';
    const validPrev = prevCh === ' ' || prevCh === '\t' || prevCh === '\n' || prevCh === '\r' || prevCh === '/';
    let after = pos + target.length;
    while (after < rawAttrs.length && (rawAttrs[after] === ' ' || rawAttrs[after] === '\t')) after++;
    if (validPrev && rawAttrs[after] === '=') {
      after++;
      while (after < rawAttrs.length && (rawAttrs[after] === ' ' || rawAttrs[after] === '\t')) after++;
      if (after >= rawAttrs.length) return null;
      const quote = rawAttrs[after]!;
      if (quote === '"' || quote === "'") {
        const end = rawAttrs.indexOf(quote, after + 1);
        return end === -1 ? null : rawAttrs.slice(after + 1, end).trim();
      }
      let end = after;
      while (end < rawAttrs.length && rawAttrs[end] !== ' ' && rawAttrs[end] !== '\t' && rawAttrs[end] !== '\n' && rawAttrs[end] !== '\r') {
        end++;
      }
      return rawAttrs.slice(after, end).trim();
    }
    idx = pos + target.length;
  }
  return null;
}

function isSafeRelativeAssetRef(ref: string): boolean {
  if (!ref || ref.includes('\0')) return false;
  const trimmed = ref.trim();
  if (!trimmed || trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.startsWith('#')) return false;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('http:') || lower.startsWith('https:') || lower.startsWith('data:') || lower.startsWith('javascript:') || lower.startsWith('blob:')) {
    return false;
  }
  return true;
}

function escapeInlineTagClose(content: string, tagName: 'script' | 'style'): string {
  const needle = `</${tagName}`;
  let out = '';
  let i = 0;
  const lower = content.toLowerCase();
  while (i < content.length) {
    const found = lower.indexOf(needle, i);
    if (found === -1) {
      out += content.slice(i);
      break;
    }
    out += content.slice(i, found) + `<\\/${tagName}`;
    i = found + needle.length;
  }
  return out;
}

/**
 * Bounded zero-dependency static HTML preview bundler.
 * Inlines relative local `<link rel="stylesheet" href="...">` and `<script src="...">`
 * files strictly inside the workspace boundary so multi-file HTML projects preview cleanly
 * inside sandboxed iframes without spawning a local HTTP server.
 */
export function packLocalHtmlPreview(
  workspaceRoot: string,
  relHtmlPath: string
): { html: string; packedAssets: number; totalBytes: number } {
  const absHtml = resolveWorkspaceRelativePath(workspaceRoot, relHtmlPath);
  if (!absHtml) throw new Error('HTML preview path is outside the locked workspace.');
  const htmlStat = fs.lstatSync(absHtml);
  if (htmlStat.isSymbolicLink() || !htmlStat.isFile()) {
    throw new Error('Only regular HTML workspace files can be previewed.');
  }
  if (htmlStat.size > MAX_PACK_ASSET_BYTES) {
    throw new Error('HTML file exceeds preview size cap.');
  }
  const rawHtml = fs.readFileSync(absHtml, 'utf8');
  if (rawHtml.includes('\0')) {
    throw new Error('Binary content cannot be previewed as HTML.');
  }

  const baseDir = path.dirname(absHtml);
  let packedAssets = 0;
  let totalBytes = Buffer.byteLength(rawHtml, 'utf8');
  const outParts: string[] = [];
  let cursor = 0;

  while (cursor < rawHtml.length) {
    const lt = rawHtml.indexOf('<', cursor);
    if (lt === -1) {
      outParts.push(rawHtml.slice(cursor));
      break;
    }
    if (lt > cursor) outParts.push(rawHtml.slice(cursor, lt));

    if (rawHtml.startsWith('<!--', lt)) {
      const endComment = rawHtml.indexOf('-->', lt + 4);
      const next = endComment === -1 ? rawHtml.length : endComment + 3;
      outParts.push(rawHtml.slice(lt, next));
      cursor = next;
      continue;
    }

    let gt = lt + 1;
    let quote: string | null = null;
    while (gt < rawHtml.length) {
      const ch = rawHtml[gt]!;
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      gt++;
    }
    if (gt >= rawHtml.length) {
      outParts.push(rawHtml.slice(lt));
      break;
    }

    const tagContent = rawHtml.slice(lt + 1, gt);
    const trimmedTag = tagContent.trim();
    const spaceIdx = trimmedTag.search(/[\s/>]/);
    const tagName = (spaceIdx === -1 ? trimmedTag : trimmedTag.slice(0, spaceIdx)).toLowerCase();
    const rawAttrs = spaceIdx === -1 ? '' : trimmedTag.slice(spaceIdx);

    if (tagName === 'base' && extractAttributeValue(rawAttrs, 'href')) {
      throw new Error('HTML preview refuses <base href> overrides.');
    }

    const readBundledAsset = (ref: string): string | null => {
      if (packedAssets >= MAX_PACK_ASSETS || !isSafeRelativeAssetRef(ref)) return null;
      const cleanRef = ref.split(/[?#]/, 1)[0] ?? '';
      if (!cleanRef) return null;
      const candidate = path.resolve(baseDir, cleanRef);
      if (!isPhysicalPathAllowed(candidate, [workspaceRoot], false)) return null;
      if (isIgnoredByCausyneIgnore(candidate, workspaceRoot, false)) return null;
      try {
        const stat = fs.lstatSync(candidate);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_PACK_ASSET_BYTES) return null;
        if (totalBytes + stat.size > MAX_PACK_TOTAL_BYTES) return null;
        const buf = fs.readFileSync(candidate);
        if (buf.includes(0)) return null;
        packedAssets++;
        totalBytes += buf.length;
        return buf.toString('utf8');
      } catch {
        return null;
      }
    };

    if (tagName === 'link') {
      const rel = (extractAttributeValue(rawAttrs, 'rel') || '').toLowerCase();
      const href = extractAttributeValue(rawAttrs, 'href');
      if (rel.split(/\s+/).includes('stylesheet') && href) {
        const css = readBundledAsset(href);
        if (css !== null) {
          outParts.push(`<style>${escapeInlineTagClose(css, 'style')}</style>`);
          cursor = gt + 1;
          continue;
        }
      }
    }

    if (tagName === 'script') {
      const src = extractAttributeValue(rawAttrs, 'src');
      if (src) {
        const js = readBundledAsset(src);
        if (js !== null) {
          const closePos = rawHtml.toLowerCase().indexOf('</script>', gt + 1);
          const scriptType = extractAttributeValue(rawAttrs, 'type');
          const typeAttr = scriptType && scriptType.toLowerCase() === 'module' ? ' type="module"' : '';
          outParts.push(`<script${typeAttr}>${escapeInlineTagClose(js, 'script')}</script>`);
          cursor = closePos === -1 ? gt + 1 : closePos + '</script>'.length;
          continue;
        }
      }
    }

    outParts.push(rawHtml.slice(lt, gt + 1));
    cursor = gt + 1;
  }

  return { html: outParts.join(''), packedAssets, totalBytes };
}
