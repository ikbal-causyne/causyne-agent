import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import { getErrorMessage, type ToolWorkspaceContext } from './toolPathSafety.js';

function decodePdfLiteral(raw: string): string {
  return raw.replace(/\\([nrt()\\]|[0-7]{1,3})/g, (_match, token: string) => {
    if (token === 'n') return '\n';
    if (token === 'r') return '\r';
    if (token === 't') return '\t';
    if (token === '(' || token === ')' || token === '\\') return token;
    return String.fromCharCode(parseInt(token, 8));
  });
}

function extractTextFromPdfBuffer(buffer: Buffer): string {
  const textChunks: string[] = [];
  const content = buffer.toString('binary');

  let pos = 0;
  while (pos < content.length) {
    const start = content.indexOf('BT', pos);
    if (start === -1) break;
    const end = content.indexOf('ET', start + 2);
    if (end === -1) break;
    const block = content.slice(start, end + 2);
    pos = end + 2;

    const strRegex = /\(([^)]{1,4096})\)/g;
    let strMatch: RegExpExecArray | null;
    while ((strMatch = strRegex.exec(block)) !== null) {
      const rawText = decodePdfLiteral(strMatch[1] ?? '');
      if (rawText && rawText.trim().length > 0 && !rawText.startsWith('F') && !rawText.includes('\x00')) {
        textChunks.push(rawText);
      }
    }
  }

  if (textChunks.length < 5) {
    const printableRegex = /[\x20-\x7E\r\n\t]{5,}/g;
    const matches = content.match(printableRegex) || [];
    const keywords = ['obj', 'endobj', 'stream', 'endstream', 'xref', 'trailer', 'startxref', 'Catalog', 'Pages', 'Font', 'XObject', 'ProcSet', 'MediaBox'];
    const filtered = matches.filter((s) => {
      const trimmed = s.trim();
      if (trimmed.length < 5) return false;
      if (keywords.some((k) => trimmed === k || trimmed.startsWith('/') || trimmed.includes('<<') || trimmed.includes('>>'))) return false;
      return true;
    });
    if (filtered.length > textChunks.length) {
      return filtered.join('\n');
    }
  }

  return textChunks.join(' ');
}

export interface PdfReadArgs {
  path?: string | undefined;
  maxChars?: number | undefined;
}

export interface PdfReadResult {
  success: boolean;
  output?: string | undefined;
  error?: string | undefined;
  charCount?: number | undefined;
  rawExtracted?: string | undefined;
}

export const pdfRead = {
  schema: {
    name: 'pdf_read',
    description: 'Extract text content from a local PDF document file. Ideal for reading attached PDFs, reports, scripts, and theses.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the .pdf file.'
        },
        maxChars: {
          type: 'number',
          description: 'Maximum characters to return (defaults to 30000 to protect context window).'
        }
      },
      required: ['path']
    }
  },
  async execute(args: PdfReadArgs = {}, _context?: ToolWorkspaceContext): Promise<PdfReadResult> {
    try {
      if (typeof args?.path !== 'string' || !args.path.trim()) {
        return { success: false, error: 'PDF path is required' };
      }
      const target = args.path.replace(/^~\//, os.homedir() + '/');

      if (!fsSync.existsSync(target)) {
        return { success: false, error: `PDF file does not exist at path: ${target}` };
      }

      const buffer = await fs.readFile(target);
      let extractedText = extractTextFromPdfBuffer(buffer);
      extractedText = extractedText.replace(/\s{3,}/g, '\n\n').trim();

      if (!extractedText || extractedText.length < 20) {
        return {
          success: true,
          output: `[NOTICE: Only minimal text extracted (${extractedText.length} chars). The PDF might be scanned/image-based or heavily FlateDecode-compressed. For image-based PDFs, try converting pages to images or using OCR.]`,
          rawExtracted: extractedText
        };
      }

      const maxLimit = args.maxChars || 30000;
      if (extractedText.length > maxLimit) {
        extractedText = extractedText.substring(0, maxLimit) + `\n\n[... PDF TEXT TRUNCATED TO ${maxLimit} CHARACTERS ...]`;
      }

      return { success: true, output: extractedText, charCount: extractedText.length };
    } catch (e: unknown) {
      return { success: false, error: `Failed to read PDF: ${getErrorMessage(e)}` };
    }
  }
};
