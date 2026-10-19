import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';

// Lightweight, zero-dependency PDF text extractor
// Extracts printable ASCII/UTF-8 text streams and string literals inside PDF objects () and []
// This allows Causyne Agent to read documents like resumes, theses, and scripts without heavy C++/binary dependencies.
function extractTextFromPdfBuffer(buffer) {
  const textChunks = [];
  const content = buffer.toString('binary');
  
  // 1. Look for text objects inside BT (Begin Text) ... ET (End Text) blocks
  const btEtRegex = /BT[\s\S]*?ET/g;
  let match;
  
  while ((match = btEtRegex.exec(content)) !== null) {
    const block = match[0];
    // Match string literals inside parentheses (e.g., (Hello World) Tj or [(Hello) -10 (World)] TJ)
    const strRegex = /\(([^)]+)\)/g;
    let strMatch;
    while ((strMatch = strRegex.exec(block)) !== null) {
      let rawText = strMatch[1];
      // Basic PDF octal/escape decoding
      rawText = rawText
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\\(/g, '(')
        .replace(/\\\)/g, ')')
        .replace(/\\\\/g, '\\')
        .replace(/\\(\d{1,3})/g, (m, oct) => String.fromCharCode(parseInt(oct, 8)));
      
      // Filter out raw font names / binary junk
      if (rawText && rawText.trim().length > 0 && !rawText.startsWith('F') && !rawText.includes('\x00')) {
        textChunks.push(rawText);
      }
    }
  }

  // 2. Fallback if PDF is uncompressed or structured differently (e.g. standard printable strings > 4 chars)
  if (textChunks.length < 5) {
    const printableRegex = /[\x20-\x7E\r\n\t]{5,}/g;
    const matches = content.match(printableRegex) || [];
    const filtered = matches.filter(s => {
      const trimmed = s.trim();
      if (trimmed.length < 5) return false;
      // Skip common PDF internal keywords
      const keywords = ['obj', 'endobj', 'stream', 'endstream', 'xref', 'trailer', 'startxref', 'Catalog', 'Pages', 'Font', 'XObject', 'ProcSet', 'MediaBox'];
      if (keywords.some(k => trimmed === k || trimmed.startsWith('/') || trimmed.includes('<<') || trimmed.includes('>>'))) return false;
      return true;
    });
    if (filtered.length > textChunks.length) {
      return filtered.join('\n');
    }
  }

  return textChunks.join(' ');
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
  async execute(args) {
    try {
      const target = args.path.replace(/^~\//, os.homedir() + '/');
      
      if (!fsSync.existsSync(target)) {
        return { success: false, error: `PDF file does not exist at path: ${target}` };
      }

      const buffer = await fs.readFile(target);
      let extractedText = extractTextFromPdfBuffer(buffer);
      
      // Clean up whitespace
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
    } catch (e) {
      return { success: false, error: `Failed to read PDF: ${e.message}` };
    }
  }
};
