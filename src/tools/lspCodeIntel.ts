/**
 * Causyne Agent — Native LSP Code Intelligence Tool (`code.lsp`) (Phase B1)
 *
 * Exposes live compiler diagnostics, go-to-definition, find-references, hover
 * type signatures, document symbols, and workspace symbol search via standard
 * Language Server Protocol servers installed on the host.
 */

import path from 'node:path';
import {
  detectInstalledLspServers,
  matchingSpecsForFile
} from '../lsp/lspCatalog.js';
import {
  formatDiagnosticsCompact,
  lspSessionManager
} from '../lsp/lspClient.js';
import {
  boundedInteger,
  resolveScopedPath,
  resolveToolWorkspaceRoots,
  sanitizeToolError,
  sanitizeToolText,
  type ToolWorkspaceContext
} from './toolPathSafety.js';

export interface LspCodeIntelArgs {
  action?: string | undefined;
  path?: string | undefined;
  line?: number | undefined;
  column?: number | undefined;
  query?: string | undefined;
  includeDeclaration?: boolean | undefined;
}

export interface LspCodeIntelResult {
  success: boolean;
  output?: string | undefined;
  error?: string | undefined;
}

function formatLocationList(
  locations: ReadonlyArray<{ file: string; line: number; column: number }>,
  workspaceRoot: string
): string {
  if (locations.length === 0) return 'No locations found.';
  return locations.map((loc) => {
    const rel = path.relative(workspaceRoot, loc.file);
    const shown = rel && !rel.startsWith('..') ? rel : loc.file;
    return `  ${sanitizeToolText(shown, 260)}:${loc.line}:${loc.column}`;
  }).join('\n');
}

export function formatLspStatusReport(workspaceRoot = process.cwd()): string {
  const detected = detectInstalledLspServers(workspaceRoot);
  const active = lspSessionManager.listActive();
  const lines = ['Language Server Protocol (LSP) Code Intelligence', ''];
  const installed = detected.filter((d) => d.available);
  lines.push(`Installed servers (${installed.length}/${detected.length}):`);
  for (const item of detected) {
    const mark = item.available ? '✓' : '·';
    const detail = item.available
      ? sanitizeToolText(item.executablePath, 200)
      : `not found (${item.spec.installHint})`;
    lines.push(`  ${mark} ${item.spec.id.padEnd(14)} ${detail}`);
  }
  lines.push('');
  lines.push(`Active sessions: ${active.length}`);
  for (const sess of active) {
    lines.push(`  • ${sess.serverId} @ ${sanitizeToolText(sess.workspaceRoot, 200)} (${sess.alive ? 'running' : 'stopped'})`);
  }
  return lines.join('\n');
}

export const lspCodeIntel = {
  schema: {
    name: 'code.lsp',
    description: 'Real-time Language Server Protocol (LSP) semantic code intelligence: live type diagnostics, go-to-definition, find-references, hover signatures, document symbols, and workspace symbol search.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'status',
            'diagnostics',
            'definition',
            'type_definition',
            'implementation',
            'references',
            'hover',
            'symbols',
            'workspace_symbols',
            'incoming_calls',
            'outgoing_calls'
          ],
          description: 'LSP query action to perform.'
        },
        path: {
          type: 'string',
          description: 'Workspace file path (required for diagnostics, definition, references, hover, symbols).'
        },
        line: {
          type: 'integer',
          description: '1-based line number (required for definition, references, hover).'
        },
        column: {
          type: 'integer',
          description: '1-based column number (defaults to 1).'
        },
        query: {
          type: 'string',
          description: 'Symbol query string (for workspace_symbols).'
        },
        includeDeclaration: {
          type: 'boolean',
          description: 'Include declaration in references results (defaults to true).'
        }
      },
      required: ['action']
    }
  },

  async execute(args: LspCodeIntelArgs = {}, context: ToolWorkspaceContext = {}): Promise<LspCodeIntelResult> {
    try {
      const safeArgs = args && typeof args === 'object' ? args : {};
      const action = typeof safeArgs.action === 'string' ? safeArgs.action.trim().toLowerCase() : 'status';
      const scope = resolveToolWorkspaceRoots(context);
      const workspaceRoot = scope.primaryRoot || process.cwd();

      if (action === 'status') {
        return { success: true, output: formatLspStatusReport(workspaceRoot) };
      }

      if (action === 'workspace_symbols') {
        const query = typeof safeArgs.query === 'string' ? safeArgs.query.trim() : '';
        if (!query) return { success: false, error: 'workspace_symbols requires a non-empty query string.' };
        const targetPath = typeof safeArgs.path === 'string' && safeArgs.path.trim()
          ? resolveScopedPath(safeArgs.path, context)
          : null;
        let session = null;
        if (targetPath) {
          const started = await lspSessionManager.getOrStartForFile(targetPath, workspaceRoot);
          session = started?.session ?? null;
        } else {
          const active = lspSessionManager.listActive().find((s) => s.alive);
          if (active) {
            const detected = detectInstalledLspServers(workspaceRoot).find((d) => d.spec.id === active.serverId && d.executablePath);
            if (detected?.executablePath) {
              session = await lspSessionManager.getOrStartSession({
                serverId: detected.spec.id,
                command: detected.executablePath,
                args: detected.spec.args,
                workspaceRoot: active.workspaceRoot
              });
            }
          }
        }
        if (!session) {
          return {
            success: false,
            error: 'No active LSP session found for workspace_symbols. Provide a sample file path in `path` to start the matching language server.'
          };
        }
        const symbols = await session.workspaceSymbols(query);
        if (symbols.length === 0) return { success: true, output: `No workspace symbols matched "${sanitizeToolText(query, 80)}".` };
        const lines = symbols.slice(0, 60).map((s) => {
          const rel = path.relative(workspaceRoot, s.file);
          const shown = rel && !rel.startsWith('..') ? rel : s.file;
          const container = s.containerName ? ` (${s.containerName})` : '';
          return `  [${s.kind}] ${s.name}${container} — ${sanitizeToolText(shown, 200)}:${s.line}:${s.column}`;
        });
        return { success: true, output: lines.join('\n') };
      }

      if (typeof safeArgs.path !== 'string' || !safeArgs.path.trim()) {
        return { success: false, error: `LSP action "${action}" requires a workspace file path.` };
      }
      const targetFile = resolveScopedPath(safeArgs.path, context);
      const started = await lspSessionManager.getOrStartForFile(targetFile, workspaceRoot);
      if (!started) {
        const specs = matchingSpecsForFile(targetFile);
        const hint = specs.length > 0
          ? `Install one of: ${specs.map((s) => `${s.command} (${s.installHint})`).join(' | ')}`
          : `No built-in LSP configuration for file extension "${path.extname(targetFile) || '(none)'}".`;
        return {
          success: false,
          error: `No installed Language Server available for ${sanitizeToolText(path.basename(targetFile), 120)}. ${hint}`
        };
      }

      const { session } = started;

      if (action === 'diagnostics') {
        const diags = await session.getDiagnostics(targetFile, 800);
        return {
          success: true,
          output: formatDiagnosticsCompact(diags, workspaceRoot)
        };
      }

      if (action === 'symbols') {
        const symbols = await session.documentSymbols(targetFile);
        if (symbols.length === 0) return { success: true, output: 'No symbols returned by language server.' };
        const lines = symbols.slice(0, 120).map((s) => {
          const container = s.containerName ? `${s.containerName}.` : '';
          return `  [${s.kind}] ${container}${s.name} (line ${s.line}:${s.column})`;
        });
        return { success: true, output: lines.join('\n') };
      }

      const line = boundedInteger(safeArgs.line, 0, 0, 1_000_000);
      const column = boundedInteger(safeArgs.column, 1, 1, 10_000);
      if (line < 1) {
        return { success: false, error: `LSP action "${action}" requires a 1-based positive integer line number.` };
      }

      if (action === 'definition') {
        const locs = await session.definition(targetFile, line, column);
        return { success: true, output: formatLocationList(locs, workspaceRoot) };
      }

      if (action === 'type_definition') {
        const locs = await session.typeDefinition(targetFile, line, column);
        return { success: true, output: formatLocationList(locs, workspaceRoot) };
      }

      if (action === 'implementation') {
        const locs = await session.implementation(targetFile, line, column);
        return { success: true, output: formatLocationList(locs, workspaceRoot) };
      }

      if (action === 'incoming_calls' || action === 'outgoing_calls') {
        const direction = action === 'incoming_calls' ? 'incoming' : 'outgoing';
        const calls = await session.callHierarchy(targetFile, line, column, direction);
        if (calls.length === 0) return { success: true, output: `No ${direction} calls found.` };
        const formatted = calls.map((c) => {
          const rel = path.relative(workspaceRoot, c.file);
          const shown = rel && !rel.startsWith('..') ? rel : c.file;
          return `  [${c.kind}] ${c.name} — ${sanitizeToolText(shown, 220)}:${c.line}:${c.column}`;
        }).join('\n');
        return { success: true, output: formatted };
      }

      if (action === 'references') {
        const locs = await session.references(targetFile, line, column, safeArgs.includeDeclaration !== false);
        return { success: true, output: formatLocationList(locs, workspaceRoot) };
      }

      if (action === 'hover') {
        const text = await session.hover(targetFile, line, column);
        return { success: true, output: text || 'No hover information available at this position.' };
      }

      return { success: false, error: `Unknown LSP action "${sanitizeToolText(action, 40)}".` };
    } catch (err: unknown) {
      return { success: false, error: sanitizeToolError(err) };
    }
  }
};
