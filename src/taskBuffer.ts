import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from './utils/paths.js';

function bufferDir(): string {
  return path.join(causyneHome(), 'buffers');
}

export class TaskBuffer {
  constructor() {
    this.ensureDir();
  }

  ensureDir(): void {
    const dir = bufferDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  safeTaskId(taskId: unknown): string {
    const cleaned = String(taskId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+/, '');
    return cleaned.length > 0 ? cleaned.slice(0, 64) : 'default';
  }

  getBufferPath(taskId: unknown): string {
    const dir = path.resolve(bufferDir());
    const target = path.resolve(dir, `${this.safeTaskId(taskId)}.jsonl`);
    const rel = path.relative(dir, target);
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error('Invalid task buffer identifier');
    }
    return target;
  }

  async appendOutput(taskId: string, stepData: Record<string, unknown>): Promise<void> {
    this.ensureDir();
    const file = this.getBufferPath(taskId);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) return;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    }
    const payload = stepData && typeof stepData === 'object' ? stepData : { value: stepData };
    let serialized: string;
    try {
      serialized = JSON.stringify({ ts: Date.now(), ...payload });
    } catch {
      serialized = JSON.stringify({ ts: Date.now(), error: 'unserializable_step_data' });
    }
    const MAX_STEP_JSON_BYTES = 512 * 1024;
    if (serialized.length > MAX_STEP_JSON_BYTES) {
      serialized = JSON.stringify({ ts: Date.now(), truncated: true, preview: serialized.slice(0, 4096) });
    }
    fs.appendFileSync(file, serialized + '\n', { mode: 0o600 });
  }

  async getBuffer(taskId: string): Promise<Record<string, unknown>[]> {
    const file = this.getBufferPath(taskId);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch {
      return [];
    }
    const MAX_BUFFER_FILE_BYTES = 8 * 1024 * 1024;
    if (!stat.isFile() || stat.size > MAX_BUFFER_FILE_BYTES) return [];

    const content = fs.readFileSync(file, 'utf8');
    const entries: Record<string, unknown>[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          entries.push(parsed as Record<string, unknown>);
        }
      } catch {
        // Ignore truncated/corrupt JSONL line rather than losing the entire buffer.
      }
    }
    return entries;
  }

  async clearBuffer(taskId: string): Promise<void> {
    const file = this.getBufferPath(taskId);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile()) fs.unlinkSync(file);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    }
  }
}
