import fs from 'node:fs/promises';
import { getErrorMessage, assertSafeWorkspaceInput, boundedInteger, sanitizeToolError, sanitizeToolText } from './toolPathSafety.js';
const MAX_PDF_FILE_BYTES = 10 * 1024 * 1024;
function decodePdfLiteral(raw) {
    return raw.replace(/\\([nrt()\\]|[0-7]{1,3})/g, (_match, token) => {
        if (token === 'n')
            return '\n';
        if (token === 'r')
            return '\r';
        if (token === 't')
            return '\t';
        if (token === '(' || token === ')' || token === '\\')
            return token;
        return String.fromCharCode(parseInt(token, 8));
    });
}
function extractTextFromPdfBuffer(buffer) {
    const textChunks = [];
    const content = buffer.toString('binary');
    let pos = 0;
    while (pos < content.length) {
        const start = content.indexOf('BT', pos);
        if (start === -1)
            break;
        const end = content.indexOf('ET', start + 2);
        if (end === -1)
            break;
        const block = content.slice(start, end + 2);
        pos = end + 2;
        const strRegex = /\(([^)]{1,4096})\)/g;
        let strMatch;
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
            if (trimmed.length < 5)
                return false;
            if (keywords.some((k) => trimmed === k || trimmed.startsWith('/') || trimmed.includes('<<') || trimmed.includes('>>')))
                return false;
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
    async execute(args = {}, context) {
        try {
            const { resolved } = await assertSafeWorkspaceInput(args?.path, context, { maxBytes: MAX_PDF_FILE_BYTES });
            const buffer = await fs.readFile(resolved);
            if (buffer.length < 5 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
                return { success: false, error: 'Target file is not a valid PDF document (missing %PDF- header).' };
            }
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
        }
        catch (e) {
            return { success: false, error: `Failed to read PDF: ${getErrorMessage(e)}` };
        }
    }
};
