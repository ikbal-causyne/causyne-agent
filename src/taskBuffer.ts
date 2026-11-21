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
    const entry = JSON.stringify({ ts: Date.now(), ...stepData }) + '\n';
    fs.appendFileSync(file, entry, { mode: 0o600 });
  }

  async getBuffer(taskId: string): Promise<Record<string, unknown>[]> {
    const file = this.getBufferPath(taskId);
    if (!fs.existsSync(file)) return [];

    const content = fs.readFileSync(file, 'utf8');
    return content.split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l) as Record<string, unknown>);
  }

  async clearBuffer(taskId: string): Promise<void> {
    const file = this.getBufferPath(taskId);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
}
