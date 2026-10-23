// Base adapter contract and safe I/O utilities for peer AI agent session readers.
// Authorship: Strict TypeScript (Causyne Agent).
import fs from 'node:fs';
export function isSafeIdentifier(id) {
    if (!id || typeof id !== 'string')
        return false;
    if (id.includes('..') || id.includes('/') || id.includes('\\') || id.includes('\0'))
        return false;
    return /^[a-zA-Z0-9_\-\.]+$/.test(id);
}
/**
 * Read transcript lines with strict memory bounds to prevent Node process OOM on oversized logs.
 */
export function readBoundedLines(filePath, maxBytes = 25 * 1024 * 1024) {
    try {
        const stat = fs.statSync(filePath);
        if (stat.size <= maxBytes) {
            return fs.readFileSync(filePath, 'utf8').split('\n');
        }
        const headSize = 2 * 1024 * 1024;
        const tailSize = 6 * 1024 * 1024;
        const fd = fs.openSync(filePath, 'r');
        try {
            const headBuf = Buffer.alloc(headSize);
            const headRead = fs.readSync(fd, headBuf, 0, headSize, 0);
            const headText = headBuf.toString('utf8', 0, headRead);
            const headLines = headText.split('\n');
            if (headLines.length > 0)
                headLines.pop();
            const tailPos = Math.max(0, stat.size - tailSize);
            const tailBuf = Buffer.alloc(tailSize);
            const tailRead = fs.readSync(fd, tailBuf, 0, tailSize, tailPos);
            const tailText = tailBuf.toString('utf8', 0, tailRead);
            const tailLines = tailText.split('\n');
            if (tailLines.length > 0)
                tailLines.shift();
            return [...headLines, ...tailLines];
        }
        finally {
            fs.closeSync(fd);
        }
    }
    catch {
        return [];
    }
}
export class BaseContinuumAdapter {
}
