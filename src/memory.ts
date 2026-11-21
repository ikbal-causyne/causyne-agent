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

export function getMemory(): MemoryStoreData {
  try {
    const filePath = initMemory();
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
