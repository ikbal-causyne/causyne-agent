import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from './utils/paths.js';

const BUFFER_DIR = path.join(causyneHome(), 'buffers');

export class TaskBuffer {
  constructor() {
    this.ensureDir();
  }

  ensureDir(): void {
    if (!fs.existsSync(BUFFER_DIR)) {
      fs.mkdirSync(BUFFER_DIR, { recursive: true });
    }
  }

  getBufferPath(taskId: string): string {
    return path.join(BUFFER_DIR, `${taskId}.jsonl`);
  }

  async appendOutput(taskId: string, stepData: Record<string, unknown>): Promise<void> {
    const file = this.getBufferPath(taskId);
    const entry = JSON.stringify({ ts: Date.now(), ...stepData }) + '\n';
    fs.appendFileSync(file, entry);
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
