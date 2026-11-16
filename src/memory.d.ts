import type {
  PersistentMemoryData,
  RecordFactOptions,
  FormatMemoryOptions
} from './memory/scopedFacts.js';

export type MemoryStoreData = PersistentMemoryData;

export function getMemory(): MemoryStoreData;
export function saveMemory(data: MemoryStoreData): void;
export function addFact(factStr: string, options?: RecordFactOptions): void;
export function clearMemory(): void;
export function getMemoryContextString(options?: string | FormatMemoryOptions): string;
