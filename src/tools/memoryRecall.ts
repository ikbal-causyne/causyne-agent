/**
 * @file src/tools/memoryRecall.ts
 * `memory_recall` — 3-Layer Progressive Episodic Memory Disclosure & Structural Symbol Folding Tool.
 *
 * Implements the token-efficient 3-layer retrieval workflow:
 *   1. `search`   — Layer 1 compact index (~50 tokens/row) ranked by query match + ACT-R activation.
 *   2. `timeline` — Layer 2 chronological window (`depthBefore`, `depthAfter`) around an `anchorId`.
 *   3. `get`      — Layer 3 full observation details (`narrative`, `facts`, `filesModified`) for `ids`, capped at 64 KB.
 *   4. `outline`  — Folded structural symbol outline (`[lineStart-lineEnd]`) of a source file before targeted `fs_read`.
 *   5. `stats`    — Episodic memory store telemetry and archive bridge status.
 *
 * Authorship: Strict TypeScript (Causyne Agent).
 */

import os from 'node:os';
import path from 'node:path';
import { episodicStore } from '../memory/episodicStore.js';
import { foldSourceFileOutline } from '../memory/symbolFolder.js';
import type { ObservationType } from '../memory/episodicTypes.js';

interface MemoryRecallContext {
  workspaceRoot?: string | undefined;
  parentLoop?: {
    workspaceRoot?: string | undefined;
  } | undefined;
}

interface MemoryRecallArgs {
  action?: 'search' | 'timeline' | 'get' | 'outline' | 'stats' | undefined;
  query?: string | undefined;
  type?: ObservationType | 'summary' | undefined;
  limit?: number | undefined;
  workspaceOnly?: boolean | undefined;
  anchorId?: string | number | undefined;
  depthBefore?: number | undefined;
  depthAfter?: number | undefined;
  ids?: readonly (string | number)[] | undefined;
  filePath?: string | undefined;
  path?: string | undefined;
  file_path?: string | undefined;
  filepath?: string | undefined;
  target?: string | undefined;
}

export const memoryRecall = {
  schema: {
    name: 'memory_recall',
    description:
      'Progressive 3-layer episodic memory recall and structural file symbol folding. ' +
      'Follow the 3-layer workflow to save tokens: (1) action="search" to get compact index IDs (#1, #2), ' +
      '(2) action="timeline" with anchorId to see chronological context around an ID, ' +
      '(3) action="get" with ids=[...] to fetch full narratives only for relevant observations, ' +
      'or (4) action="outline" with filePath to get a folded symbol signature outline with [lineStart-lineEnd] ranges.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'timeline', 'get', 'outline', 'stats'],
          description: 'Progressive recall layer: search (index), timeline (window), get (full details), outline (symbol folding), or stats.'
        },
        query: {
          type: 'string',
          description: 'Search keywords for action="search", or symbol filter for action="outline".'
        },
        type: {
          type: 'string',
          enum: ['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'verification', 'summary'],
          description: 'Optional observation category filter for action="search".'
        },
        limit: {
          type: 'number',
          description: 'Maximum index rows to return for action="search" (default: 15, max: 50).'
        },
        workspaceOnly: {
          type: 'boolean',
          description: 'Restrict search to the current workspace project (default: false).'
        },
        anchorId: {
          type: 'string',
          description: 'Target observation ID (e.g. "#12" or "12") for action="timeline".'
        },
        depthBefore: {
          type: 'number',
          description: 'Observations before anchorId in action="timeline" (default: 5).'
        },
        depthAfter: {
          type: 'number',
          description: 'Observations after anchorId in action="timeline" (default: 5).'
        },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Observation IDs to fetch in full for action="get" (e.g. ["#12", "#15"]).'
        },
        filePath: {
          type: 'string',
          description: 'Source file path to fold into symbol signatures and [lineStart-lineEnd] ranges for action="outline".'
        }
      },
      required: ['action']
    }
  },

  async execute(rawArgs: unknown, context: MemoryRecallContext = {}) {
    const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? rawArgs
      : {}) as MemoryRecallArgs;
    const rawFileCandidate = String(
      args.filePath ?? args.path ?? args.file_path ?? args.filepath ?? args.target ?? ''
    ).trim();
    const inferredAction = args.action
      ?? (rawFileCandidate ? 'outline' : undefined)
      ?? (args.anchorId !== undefined ? 'timeline' : undefined)
      ?? (Array.isArray(args.ids) && args.ids.length > 0 ? 'get' : undefined)
      ?? 'search';
    const action = inferredAction;
    const workspace = context.parentLoop?.workspaceRoot ?? context.workspaceRoot ?? process.cwd();

    try {
      if (action === 'search') {
        const res = episodicStore.searchIndex({
          query: args.query,
          workspace,
          type: args.type,
          limit: args.limit,
          workspaceOnly: args.workspaceOnly
        });
        const formatted = res.results.length === 0
          ? 'No matching episodic observations found.'
          : [
              `Found ${res.totalMatches} match(es) (showing ${res.results.length}):`,
              ...res.results.map(
                (r) => `${r.id} [${r.type}] (${r.project}) ${r.title}${r.reinforcementCount > 0 ? ` [x${r.reinforcementCount + 1}]` : ''} — score ${r.score}`
              ),
              'Next step: call memory_recall with action="timeline" (anchorId) or action="get" (ids) for full details.'
            ].join('\n');
        return {
          success: true,
          action: 'search',
          totalMatches: res.totalMatches,
          results: res.results,
          output: formatted
        };
      }

      if (action === 'timeline') {
        if (args.anchorId === undefined || String(args.anchorId).trim() === '') {
          return { success: false, error: 'Missing required parameter "anchorId" for action="timeline".' };
        }
        const windowResult = episodicStore.getTimelineWindow({
          anchorId: args.anchorId,
          workspace,
          depthBefore: args.depthBefore,
          depthAfter: args.depthAfter
        });
        if (!windowResult.anchor) {
          return {
            success: false,
            error: `Observation ${String(args.anchorId)} was not found in episodic memory.`
          };
        }
        const allItems = [
          ...windowResult.before,
          windowResult.anchor,
          ...windowResult.after
        ];
        const lines = allItems.map((item) => {
          const marker = item.isAnchor ? '>>> ' : '    ';
          const files = item.filesModified.length > 0 ? ` (${item.filesModified.join(', ')})` : '';
          return `${marker}${item.id} [${item.type}] ${item.title}${files}`;
        });
        return {
          success: true,
          action: 'timeline',
          window: windowResult,
          output: [`Timeline around ${windowResult.anchorId} (${windowResult.project}):`, ...lines].join('\n')
        };
      }

      if (action === 'get') {
        const ids = Array.isArray(args.ids) ? args.ids : [];
        if (ids.length === 0) {
          return { success: false, error: 'Missing required non-empty "ids" array for action="get".' };
        }
        const batch = episodicStore.getObservationsByIds(ids);
        const lines = batch.observations.map((obs) => [
          `### #${obs.id} [${obs.type}] ${obs.title} (${obs.project})`,
          `Tool: ${obs.toolName} | Reinforcements: ${obs.reinforcementCount}`,
          obs.filesModified.length > 0 ? `Files Modified: ${obs.filesModified.join(', ')}` : '',
          obs.filesRead.length > 0 ? `Files Read: ${obs.filesRead.join(', ')}` : '',
          `Narrative: ${obs.narrative}`,
          obs.facts.length > 0 ? `Facts: ${obs.facts.join(' | ')}` : ''
        ].filter(Boolean).join('\n'));

        if (batch.truncatedByByteLimit) {
          lines.push(`[Truncated at 64 KB ceiling; omitted IDs: ${batch.omittedIds.join(', ')}]`);
        }

        return {
          success: true,
          action: 'get',
          observations: batch.observations,
          truncatedByByteLimit: batch.truncatedByByteLimit,
          omittedIds: batch.omittedIds,
          totalBytes: batch.totalBytes,
          output: lines.join('\n\n') || 'No matching observations found for the requested IDs.'
        };
      }

      if (action === 'outline') {
        if (!rawFileCandidate) {
          return { success: false, error: 'Missing required parameter "filePath" for action="outline".' };
        }
        const expanded = rawFileCandidate.startsWith('~/')
          ? path.join(os.homedir(), rawFileCandidate.slice(2))
          : rawFileCandidate;
        const targetPath = path.isAbsolute(expanded)
          ? expanded
          : path.resolve(workspace, expanded);
        const outline = foldSourceFileOutline(targetPath, args.query);
        return {
          success: true,
          action: 'outline',
          filePath: outline.filePath,
          language: outline.language,
          totalLines: outline.totalLines,
          symbolCount: outline.symbols.length,
          output: outline.renderedOutline
        };
      }

      if (action === 'stats') {
        const stats = episodicStore.getStats(workspace);
        return {
          success: true,
          action: 'stats',
          stats,
          output: `Causyne Episodic Store: ${stats.totalObservations} total observations (${stats.projectObservations} in current project), ${stats.totalSummaries} session summaries. Archive bridge: ${stats.externalStoreAvailable ? 'active' : 'standby'}.`
        };
      }

      return { success: false, error: `Unsupported action "${String(action)}".` };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
};
