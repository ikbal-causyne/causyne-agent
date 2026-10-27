/*
 * Copyright (c) 2026 Causyne.
 * SPDX-License-Identifier: BUSL-1.1
 *
 * Causyne Document Forge — HTML/CSS-First Publishing, Headless Chrome PDF Compiler & Visual QA.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

export type DocumentPalette = 'corporate' | 'editorial_dair' | 'minimal_clean';

export interface FormalDocumentSection {
  title?: string;
  subtitle?: string;
  paragraphs?: string[];
  table?: {
    headers: string[];
    rows: string[][];
  };
  callout?: string;
}

export interface FormalDocumentSpec {
  title: string;
  subtitle?: string;
  categoryOrKicker?: string;
  authorOrProposer?: string;
  palette?: DocumentPalette;
  sections: FormalDocumentSection[];
  includeCover?: boolean;
}

export interface RenderPdfResult {
  success: boolean;
  pdfPath?: string;
  fileSizeBytes?: number;
  sizeKb?: number;
  exceeds2Mb?: boolean;
  error?: string;
}

export interface PageDensityResult {
  pageNumber: number;
  fillPercentage: number;
  isSparse: boolean; // <25% filled
}

export interface InspectPagesResult {
  success: boolean;
  pageCount?: number;
  densities?: PageDensityResult[];
  imagePaths?: string[];
  sparsePages?: number[];
  error?: string;
}

const PALETTES: Record<DocumentPalette, { primary: string; primaryDark: string; accent: string; bg: string; text: string; rule: string }> = {
  corporate: {
    primary: '#0f172a',
    primaryDark: '#020617',
    accent: '#2563eb',
    bg: '#ffffff',
    text: '#1e293b',
    rule: '#e2e8f0'
  },
  editorial_dair: {
    primary: '#78281F', // Maroon
    primaryDark: '#5C1E17',
    accent: '#D4AB0D', // Gold
    bg: '#FDF5E6', // Cream
    text: '#1B2833', // Ink
    rule: '#DCD3C4'
  },
  minimal_clean: {
    primary: '#18181b',
    primaryDark: '#09090b',
    accent: '#0284c7',
    bg: '#ffffff',
    text: '#27272a',
    rule: '#e4e4e7'
  }
};

/**
 * Compile formal publication document to pixel-perfect HTML + CSS Paged Media.
 */
export function compileDocumentHtml(spec: FormalDocumentSpec): { html: string; css: string } {
  const p = PALETTES[spec.palette || 'corporate'];

  const css = `
:root {
  --primary: ${p.primary};
  --primary-dk: ${p.primaryDark};
  --accent: ${p.accent};
  --bg: ${p.bg};
  --text: ${p.text};
  --rule: ${p.rule};
}

@page {
  size: A4 portrait;
  margin: 20mm 18mm 18mm 18mm;
  @bottom-right {
    content: "Page " counter(page);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 8.5pt;
    color: #64748b;
  }
}
@page cover {
  margin: 0;
}

* { box-sizing: border-box; }
html {
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
body {
  margin: 0;
  padding: 0;
  font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
  font-size: 10pt;
  line-height: 1.55;
  color: var(--text);
  background: #ffffff;
}

p {
  margin: 0 0 8pt;
  text-align: justify;
}
h1, h2, h3 {
  page-break-after: avoid;
  break-after: avoid;
}
h2 {
  font-size: 13pt;
  font-weight: 700;
  color: var(--primary);
  border-bottom: 1.5px solid var(--primary);
  padding-bottom: 4pt;
  margin-top: 16pt;
  margin-bottom: 8pt;
}
h3 {
  font-size: 11pt;
  font-weight: 600;
  color: var(--primary-dk);
  margin-top: 12pt;
  margin-bottom: 6pt;
}

.cover-page {
  page: cover;
  width: 210mm;
  height: 297mm;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  page-break-after: always;
  background: #ffffff;
}
.cover-band-top {
  height: 14mm;
  background: linear-gradient(90deg, var(--primary-dk) 0%, var(--primary) 40%, var(--accent) 100%);
  display: flex;
  align-items: center;
  justify-content: center;
}
.cover-band-bottom {
  height: 14mm;
  background: linear-gradient(90deg, var(--accent) 0%, var(--primary) 60%, var(--primary-dk) 100%);
}
.cover-kicker {
  color: #ffffff;
  font-size: 7.5pt;
  letter-spacing: 0.3em;
  font-weight: 600;
  text-transform: uppercase;
}
.cover-content {
  padding: 40mm 24mm;
  display: flex;
  flex-direction: column;
  justify-content: center;
  flex-grow: 1;
}
.cover-title {
  font-size: 24pt;
  font-weight: 800;
  line-height: 1.25;
  color: var(--primary);
  letter-spacing: -0.02em;
  margin-bottom: 12pt;
}
.cover-subtitle {
  font-size: 13pt;
  color: #475569;
  line-height: 1.4;
  margin-bottom: 30pt;
}
.cover-meta {
  border-left: 3px solid var(--accent);
  padding-left: 14pt;
  font-size: 10.5pt;
  color: #334155;
}

.section-block {
  margin-bottom: 16pt;
  page-break-inside: auto;
}
.callout-box {
  background: #f8fafc;
  border-left: 3.5px solid var(--accent);
  padding: 8pt 12pt;
  margin: 10pt 0;
  border-radius: 0 4px 4px 0;
  page-break-inside: avoid;
  font-size: 9.5pt;
}
table {
  width: 100%;
  border-collapse: collapse;
  margin: 10pt 0;
  page-break-inside: auto;
}
tr {
  page-break-inside: avoid;
}
th {
  background: var(--primary);
  color: #ffffff;
  font-weight: 600;
  font-size: 8.5pt;
  text-align: left;
  padding: 6pt 8pt;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
td {
  padding: 6pt 8pt;
  border-bottom: 1px solid var(--rule);
  font-size: 9pt;
  vertical-align: top;
}
tr:nth-child(even) td {
  background: rgba(0, 0, 0, 0.02);
}
`.trim();

  let bodyHtml = '';

  if (spec.includeCover !== false) {
    bodyHtml += `
<div class="cover-page">
  <div class="cover-band-top">
    <div class="cover-kicker">${escapeHtml(spec.categoryOrKicker || 'OFFICIAL PROPOSAL & TECHNICAL REPORT')}</div>
  </div>
  <div class="cover-content">
    <div class="cover-title">${escapeHtml(spec.title)}</div>
    ${spec.subtitle ? `<div class="cover-subtitle">${escapeHtml(spec.subtitle)}</div>` : ''}
    ${spec.authorOrProposer ? `<div class="cover-meta">Prepared by: <strong>${escapeHtml(spec.authorOrProposer)}</strong></div>` : ''}
  </div>
  <div class="cover-band-bottom"></div>
</div>`;
  }

  bodyHtml += '<div class="document-content">';
  for (const s of spec.sections) {
    bodyHtml += '\n<section class="section-block">';
    if (s.title) bodyHtml += `\n  <h2>${escapeHtml(s.title)}</h2>`;
    if (s.subtitle) bodyHtml += `\n  <h3>${escapeHtml(s.subtitle)}</h3>`;
    if (s.callout) bodyHtml += `\n  <div class="callout-box">${escapeHtml(s.callout)}</div>`;

    if (s.paragraphs) {
      for (const pText of s.paragraphs) {
        bodyHtml += `\n  <p>${escapeHtml(pText)}</p>`;
      }
    }

    if (s.table && s.table.headers && s.table.rows) {
      bodyHtml += '\n  <table>\n    <thead>\n      <tr>';
      for (const h of s.table.headers) {
        bodyHtml += `\n        <th>${escapeHtml(h)}</th>`;
      }
      bodyHtml += '\n      </tr>\n    </thead>\n    <tbody>';
      for (const row of s.table.rows) {
        bodyHtml += '\n      <tr>';
        for (const cell of row) {
          bodyHtml += `\n        <td>${escapeHtml(cell)}</td>`;
        }
        bodyHtml += '\n      </tr>';
      }
      bodyHtml += '\n    </tbody>\n  </table>';
    }

    bodyHtml += '\n</section>';
  }
  bodyHtml += '\n</div>';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(spec.title)}</title>
  <style>${css}</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;

  return { html, css };
}

/**
 * Locate installed Google Chrome or Chromium executable across OS targets.
 */
export function findChromePath(): string | null {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Compile HTML to pixel-perfect vector PDF via Headless Chrome with stability monitor.
 */
export async function renderHtmlToPdf(htmlFilePath: string, outputPdfPath: string, timeoutMs: number = 25000): Promise<RenderPdfResult> {
  const chromePath = findChromePath();
  if (!chromePath) {
    return { success: false, error: 'Google Chrome / Chromium executable not found on system.' };
  }

  const absHtml = path.resolve(htmlFilePath);
  const absOut = path.resolve(outputPdfPath);

  if (!fs.existsSync(absHtml)) {
    return { success: false, error: `HTML source file does not exist: ${absHtml}` };
  }

  fs.mkdirSync(path.dirname(absOut), { recursive: true });
  if (fs.existsSync(absOut)) {
    fs.unlinkSync(absOut);
  }

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-pdf-profile-'));

  return new Promise((resolve) => {
    const proc = spawn(
      chromePath,
      [
        '--headless',
        '--disable-gpu',
        '--no-sandbox',
        '--no-pdf-header-footer',
        `--user-data-dir=${profileDir}`,
        `--print-to-pdf=${absOut}`,
        `file://${absHtml}`
      ],
      { stdio: 'ignore' }
    );

    let prevSize = -1;
    let stableCount = 0;
    const interval = 250;
    let elapsed = 0;

    const timer = setInterval(() => {
      elapsed += interval;
      if (fs.existsSync(absOut)) {
        const stat = fs.statSync(absOut);
        if (stat.size === prevSize && stat.size > 0) {
          stableCount++;
          if (stableCount >= 3) {
            cleanupAndResolve(true);
            return;
          }
        } else {
          stableCount = 0;
          prevSize = stat.size;
        }
      }

      if (elapsed >= timeoutMs) {
        cleanupAndResolve(false, 'Render timed out waiting for PDF file stabilization.');
      }
    }, interval);

    function cleanupAndResolve(success: boolean, error?: string) {
      clearInterval(timer);
      try {
        proc.kill();
      } catch {}
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
      } catch {}

      if (!success || !fs.existsSync(absOut)) {
        resolve({ success: false, error: error || 'Failed to generate PDF.' });
        return;
      }

      const stat = fs.statSync(absOut);
      const sizeKb = Math.round(stat.size / 1024);
      const exceeds2Mb = sizeKb > 2048;

      resolve({
        success: true,
        pdfPath: absOut,
        fileSizeBytes: stat.size,
        sizeKb,
        exceeds2Mb
      });
    }
  });
}

/**
 * Inspect page count and visual density of generated PDF.
 */
export async function inspectPdfPages(pdfPath: string, outputImagesDir?: string): Promise<InspectPagesResult> {
  const absPdf = path.resolve(pdfPath);
  if (!fs.existsSync(absPdf)) {
    return { success: false, error: `PDF file does not exist: ${absPdf}` };
  }

  const script = `
import fitz, sys, json, os

pdf_path = sys.argv[1]
img_dir = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None

try:
    doc = fitz.open(pdf_path)
    page_count = len(doc)
    densities = []
    sparse_pages = []
    saved_images = []

    for idx, page in enumerate(doc):
        h = page.rect.height
        blocks = page.get_text("blocks")
        max_bottom = max([b[3] for b in blocks], default=0) if blocks else 0
        fill_pct = round((max_bottom / h) * 100, 1) if h > 0 else 0
        is_sparse = fill_pct < 25.0
        densities.append({"pageNumber": idx + 1, "fillPercentage": fill_pct, "isSparse": is_sparse})
        if is_sparse:
            sparse_pages.append(idx + 1)

        if img_dir:
            os.makedirs(img_dir, exist_ok=True)
            img_path = os.path.join(img_dir, f"page_{idx+1:02d}.png")
            page.get_pixmap(dpi=120).save(img_path)
            saved_images.append(img_path)

    print(json.dumps({
        "success": True,
        "pageCount": page_count,
        "densities": densities,
        "sparsePages": sparse_pages,
        "imagePaths": saved_images
    }))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;

  return new Promise((resolve) => {
    const py = spawn('python3', ['-c', script, absPdf, outputImagesDir || '']);
    let stdout = '';
    let stderr = '';

    py.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    py.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    py.on('close', (code) => {
      if (code !== 0) {
        resolve({ success: false, error: stderr.trim() || `Python process exited with code ${code}` });
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(parsed);
      } catch (err: any) {
        resolve({ success: false, error: `Failed to parse python output: ${err.message}` });
      }
    });
  });
}

function escapeHtml(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
