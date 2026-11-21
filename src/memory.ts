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

const MEMORY_FILE_PATH = path.join(causyneHome(), 'memory.json');

function initMemory(): void {
  const dir = path.dirname(MEMORY_FILE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(MEMORY_FILE_PATH)) {
    fs.writeFileSync(MEMORY_FILE_PATH, JSON.stringify({ facts: [] }, null, 2));
  }
}

export function getMemory(): MemoryStoreData {
  try {
    initMemory();
    const data = fs.readFileSync(MEMORY_FILE_PATH, 'utf-8');
    return normalizeMemoryData(JSON.parse(data));
  } catch (e: unknown) {
    console.error('Failed to read memory.json:', e instanceof Error ? e.message : String(e));
    return normalizeMemoryData({ facts: [] });
  }
}

export function saveMemory(data: MemoryStoreData): void {
  try {
    initMemory();
    fs.writeFileSync(MEMORY_FILE_PATH, JSON.stringify(data, null, 2));
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
    initMemory();
    fs.writeFileSync(MEMORY_FILE_PATH, JSON.stringify({ facts: [], entries: [] }, null, 2));
  } catch (e: unknown) {
    console.error('Failed to clear memory:', e instanceof Error ? e.message : String(e));
  }
}

export function getMemoryContextString(options?: string | FormatMemoryOptions): string {
  const mem = getMemory();
  return formatMemoryContext(mem, options);
}
