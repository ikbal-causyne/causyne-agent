/**
 * @file src/memory/episodicTypes.ts
 * Core types for Causyne Episodic Memory, ACT-R Ranking, 2-Tier IDF-Veto Deduplication,
 * 3-Layer Progressive Disclosure, Measured Context Budgeting, and Symbol Folding.
 *
 * Authorship: Strict TypeScript (Causyne Agent).
 */

export type ObservationType =
  | 'decision'
  | 'bugfix'
  | 'feature'
  | 'refactor'
  | 'discovery'
  | 'verification';

export interface EpisodicObservation {
  readonly id: number;
  readonly taskId: string;
  readonly workspace: string;
  readonly project: string;
  readonly type: ObservationType;
  readonly title: string;
  readonly subtitle: string;
  readonly narrative: string;
  readonly facts: readonly string[];
  readonly concepts: readonly string[];
  readonly filesRead: readonly string[];
  readonly filesModified: readonly string[];
  readonly toolName: string;
  readonly createdAtEpochMs: number;
  readonly reinforcedAtEpochsMs: readonly number[];
  readonly reinforcementCount: number;
  readonly source?: 'native' | 'external_bridge' | undefined;
}

export interface EpisodicSessionSummary {
  readonly id: number;
  readonly taskId: string;
  readonly workspace: string;
  readonly project: string;
  readonly request: string;
  readonly investigated: string;
  readonly learned: string;
  readonly completed: string;
  readonly nextSteps: string;
  readonly createdAtEpochMs: number;
}

export interface ProgressiveSearchRow {
  readonly id: string;
  readonly numericId: number;
  readonly kind: 'observation' | 'summary';
  readonly type: ObservationType | 'summary';
  readonly project: string;
  readonly title: string;
  readonly subtitle: string;
  readonly createdAtEpochMs: number;
  readonly reinforcementCount: number;
  readonly score: number;
}

export interface ProgressiveSearchResult {
  readonly query: string;
  readonly totalMatches: number;
  readonly results: readonly ProgressiveSearchRow[];
}

export interface TimelineWindowItem {
  readonly id: string;
  readonly numericId: number;
  readonly isAnchor: boolean;
  readonly type: ObservationType;
  readonly title: string;
  readonly subtitle: string;
  readonly toolName: string;
  readonly filesModified: readonly string[];
  readonly createdAtEpochMs: number;
}

export interface TimelineWindowResult {
  readonly anchorId: string;
  readonly project: string;
  readonly before: readonly TimelineWindowItem[];
  readonly anchor: TimelineWindowItem | null;
  readonly after: readonly TimelineWindowItem[];
}

export interface ObservationBatchResult {
  readonly requestedIds: readonly string[];
  readonly observations: readonly EpisodicObservation[];
  readonly omittedIds: readonly string[];
  readonly truncatedByByteLimit: boolean;
  readonly totalBytes: number;
}

export type FoldedSymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'method'
  | 'const';

export interface FoldedSymbolEntry {
  readonly name: string;
  readonly kind: FoldedSymbolKind;
  readonly signature: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly exported: boolean;
  readonly docComment?: string | undefined;
}

export interface FoldedFileOutline {
  readonly filePath: string;
  readonly language: string;
  readonly totalLines: number;
  readonly importCount: number;
  readonly symbols: readonly FoldedSymbolEntry[];
  readonly renderedOutline: string;
}

