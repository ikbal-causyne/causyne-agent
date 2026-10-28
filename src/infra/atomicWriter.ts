/**
 * @file src/infra/atomicWriter.ts
 * Causyne Agent — POSIX Atomic Safe File Writer
 *
 * Implements lock-free atomic file writing using temporary files and POSIX
 * atomic renameSync. Guarantees zero partial writes, zero file corruption,
 * and concurrency safety across parallel subagents.
 *
 * Authorship: Strict TypeScript (Causyne Agent).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export interface AtomicWriteOptions {
  mode?: number;
  encoding?: BufferEncoding;
}

export function atomicWriteFileSync(
  targetPath: string,
  content: string | Buffer,
  options: AtomicWriteOptions = {}
): void {
  const resolved = path.resolve(targetPath);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true, mode: options.mode ?? 0o755 });

  const randomSuffix = crypto.randomBytes(6).toString('hex');
  const tempPath = path.join(dir, `.${path.basename(resolved)}.${randomSuffix}.tmp`);

  try {
    if (typeof content === 'string') {
      fs.writeFileSync(tempPath, content, {
        encoding: options.encoding ?? 'utf8',
        mode: options.mode ?? 0o644,
        flag: 'wx'
      });
    } else {
      fs.writeFileSync(tempPath, content, {
        mode: options.mode ?? 0o644,
        flag: 'wx'
      });
    }
    fs.renameSync(tempPath, resolved);
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // Ignore cleanup error
    }
    throw err;
  }
}

export async function atomicWriteFile(
  targetPath: string,
  content: string | Buffer,
  options: AtomicWriteOptions = {}
): Promise<void> {
  atomicWriteFileSync(targetPath, content, options);
}
