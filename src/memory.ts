import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from './utils/paths.js';
import {
  formatMemoryContext,
  normalizeMemoryData,
  recordScopedFact,
  type PersistentMemoryData,
  type RecordFactOptions,
  type FormatMemoryOptions
} from './memory/scopedFacts.js';

export type MemoryStoreData = PersistentMemoryData;

function memoryFilePath(): string {
  return path.join(causyneHome(), 'memory.json');
}

function initMemory(): string {
  const filePath = memoryFilePath();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.lstatSync(filePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      fs.writeFileSync(filePath, JSON.stringify({ facts: [] }, null, 2), { flag: 'wx', mode: 0o600 });
    }
  }
  return filePath;
}

function writeMemoryAtomic(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) return;
  } catch {
    // target may not exist yet
  }
  const serialized = JSON.stringify(payload, null, 2);
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, serialized, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, filePath);
  } catch (err: unknown) {
    try { fs.unlinkSync(temporary); } catch { /* ignore cleanup error */ }
    throw err;
  }
}

export function getMemory(): MemoryStoreData {
  try {
    const filePath = initMemory();
    const MAX_MEMORY_BYTES = 4 * 1024 * 1024;
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.size > MAX_MEMORY_BYTES) return normalizeMemoryData({ facts: [] });
    const data = fs.readFileSync(filePath, 'utf-8');
    return normalizeMemoryData(JSON.parse(data));
  } catch (e: unknown) {
    console.error('Failed to read memory.json:', e instanceof Error ? e.message : String(e));
    return normalizeMemoryData({ facts: [] });
  }
}

export function saveMemory(data: MemoryStoreData): void {
  try {
    const filePath = initMemory();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (e: unknown) {
    console.error('Failed to write memory.json:', e instanceof Error ? e.message : String(e));
  }
}

export function addFact(factStr: string, options: RecordFactOptions = {}): void {
  const mem = getMemory();
  const { memory, alreadyKnown } = recordScopedFact(mem, factStr, options);
  if (!alreadyKnown || options.workspace) {
    saveMemory(memory);
  }
}

export function clearMemory(): void {
  try {
    const filePath = initMemory();
    fs.writeFileSync(filePath, JSON.stringify({ facts: [], entries: [] }, null, 2));
  } catch (e: unknown) {
    console.error('Failed to clear memory:', e instanceof Error ? e.message : String(e));
  }
}

export function getMemoryContextString(options?: string | FormatMemoryOptions): string {
  const mem = getMemory();
  return formatMemoryContext(mem, options);
}
