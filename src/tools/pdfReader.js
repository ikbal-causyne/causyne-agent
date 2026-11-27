import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import { assertSafeWorkspaceInput, boundedInteger, sanitizeToolError, sanitizeToolText } from './toolPathSafety.js';
const MAX_PDF_FILE_BYTES = 10 * 1024 * 1024;
const MAX_DECOMPRESSED_STREAM_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_DECOMPRESSED_BYTES = 16 * 1024 * 1024;
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
function decodePdfHexString(hex) {
    const cleaned = hex.replace(/[^0-9a-fA-F]/g, '');
    if (cleaned.length < 2)
        return '';
    const padded = cleaned.length % 2 === 1 ? `${cleaned}0` : cleaned;
    const bytes = Buffer.from(padded, 'hex');
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        // UTF-16BE BOM
        let out = '';
        for (let i = 2; i + 1 < bytes.length; i += 2) {
            out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
        }
        return out;
    }
    return bytes.toString('latin1');
}
function extractTextBlocksFromStream(streamContent, out) {
    let pos = 0;
    while (pos < streamContent.length) {
        const start = streamContent.indexOf('BT', pos);
        if (start === -1)
            break;
        const end = streamContent.indexOf('ET', start + 2);
        if (end === -1)
            break;
        const block = streamContent.slice(start + 2, end);
        pos = end + 2;
        let i = 0;
        while (i < block.length) {
            const ch = block[i];
            if (ch === '(') {
                let depth = 1;
                let j = i + 1;
                while (j < block.length && depth > 0) {
                    if (block[j] === '\\') {
                        j += 2;
                        continue;
                    }
                    if (block[j] === '(')
                        depth++;
                    else if (block[j] === ')')
                        depth--;
                    j++;
                }
                const raw = block.slice(i + 1, Math.max(i + 1, j - 1)).slice(0, 4096);
                const decoded = decodePdfLiteral(raw);
                if (decoded && decoded.trim().length > 0 && !decoded.includes('\x00')) {
                    out.push(decoded);
                }
                i = j;
                continue;
            }
            if (ch === '<' && block[i + 1] !== '<') {
                const close = block.indexOf('>', i + 1);
                if (close !== -1) {
                    const decoded = decodePdfHexString(block.slice(i + 1, close).slice(0, 4096));
                    if (decoded && decoded.trim().length > 0 && !decoded.includes('\x00')) {
                        out.push(decoded);
                    }
                    i = close + 1;
                    continue;
                }
            }
            i++;
        }
    }
}
function tryInflatePdfStream(rawSlice) {
    if (rawSlice.length === 0 || rawSlice.length > MAX_DECOMPRESSED_STREAM_BYTES)
        return null;
    try {
        return zlib.inflateSync(rawSlice, { maxOutputLength: MAX_DECOMPRESSED_STREAM_BYTES });
    }
    catch {
        try {
            return zlib.inflateRawSync(rawSlice, { maxOutputLength: MAX_DECOMPRESSED_STREAM_BYTES });
        }
        catch {
            return null;
        }
    }
}
export function extractTextFromPdfBuffer(buffer) {
    const textChunks = [];
    const rawBinary = buffer.toString('binary');
    // 1. Decompress FlateDecode / zlib PDF streams using built-in node:zlib
    let totalDecompressed = 0;
    let searchPos = 0;
    while (searchPos < rawBinary.length && totalDecompressed < MAX_TOTAL_DECOMPRESSED_BYTES) {
        const streamToken = rawBinary.indexOf('stream', searchPos);
        if (streamToken === -1)
            break;
        let dataStart = streamToken + 6;
        if (rawBinary[dataStart] === '\r' && rawBinary[dataStart + 1] === '\n')
            dataStart += 2;
        else if (rawBinary[dataStart] === '\n' || rawBinary[dataStart] === '\r')
            dataStart += 1;
        const endToken = rawBinary.indexOf('endstream', dataStart);
        if (endToken === -1)
            break;
        searchPos = endToken + 9;
        // Trim trailing line break before `endstream`
        let dataEnd = endToken;
        if (dataEnd > dataStart && rawBinary[dataEnd - 1] === '\n')
            dataEnd--;
        if (dataEnd > dataStart && rawBinary[dataEnd - 1] === '\r')
            dataEnd--;
        if (dataEnd <= dataStart)
            continue;
        const dictWindow = rawBinary.slice(Math.max(0, streamToken - 320), streamToken);
        if (dictWindow.includes('FlateDecode')) {
            const inflated = tryInflatePdfStream(buffer.subarray(dataStart, dataEnd));
            if (inflated && inflated.length > 0) {
                totalDecompressed += inflated.length;
                extractTextBlocksFromStream(inflated.toString('latin1'), textChunks);
            }
        }
    }
    // 2. Also scan uncompressed streams directly
    extractTextBlocksFromStream(rawBinary, textChunks);
    const combined = textChunks.join(' ').trim();
    if (combined.length < 10) {
        const printableRegex = /[\x20-\x7E\r\n\t]{5,}/g;
        const matches = rawBinary.match(printableRegex) || [];
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
    return combined;
}
export const pdfRead = {
    schema: {
        name: 'pdf_read',
        description: 'Extract text content from a local PDF document file (supports both uncompressed and FlateDecode-compressed streams). Ideal for reading attached PDFs, reports, scripts, and papers.',
        parameters: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Absolute or workspace-relative path to the .pdf file.'
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
                    output: `[NOTICE: Only minimal text extracted (${extractedText.length} chars). The PDF might be scanned/image-based. For scanned PDFs, convert pages to images and inspect visually.]`,
                    rawExtracted: extractedText
                };
            }
            extractedText = sanitizeToolText(extractedText, 120_000);
            const maxLimit = boundedInteger(args?.maxChars, 30000, 100, 100_000);
            if (extractedText.length > maxLimit) {
                extractedText = extractedText.substring(0, maxLimit) + `\n\n[... PDF TEXT TRUNCATED TO ${maxLimit} CHARACTERS ...]`;
            }
            return { success: true, output: extractedText, charCount: extractedText.length };
        }
        catch (e) {
            return { success: false, error: `Failed to read PDF: ${sanitizeToolError(e)}` };
        }
    }
};
