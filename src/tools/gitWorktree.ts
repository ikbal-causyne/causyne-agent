/**
 * Causyne Agent — Git Worktree Agent Tool (`git.worktree`) (Phase B2)
 *
 * Allows the agent and parallel subagents to create, inspect, diff, merge, and
 * clean up isolated `git worktree` sandboxes within the authorized repository.
 */

import {
  createWorktree,
  inspectWorktreeDiff,
  listWorktrees,
  mergeWorktree,
  pruneManagedWorktrees,
  removeWorktree
} from '../worktreeManager.js';
import {
  resolveToolWorkspaceRoots,
  sanitizeToolError,
  sanitizeToolText,
  type ToolWorkspaceContext
} from './toolPathSafety.js';

export interface GitWorktreeArgs {
  action?: string | undefined;
  name?: string | undefined;
  worktreeId?: string | undefined;
  baseRef?: string | undefined;
  squash?: boolean | undefined;
  commitMessage?: string | undefined;
  cleanup?: boolean | undefined;
  deleteBranch?: boolean | undefined;
}

export interface GitWorktreeResult {
  success: boolean;
  output?: string | undefined;
  error?: string | undefined;
}

export const gitWorktree = {
  schema: {
    name: 'git.worktree',
    description: 'Manage isolated git worktrees for conflict-free parallel coding and speculative refactors (create, list, diff, merge, remove, prune).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'diff', 'merge', 'remove', 'prune'],
          description: 'Worktree operation to perform.'
        },
        name: {
          type: 'string',
          description: 'Optional short slug name when creating a new worktree.'
        },
        worktreeId: {
          type: 'string',
          description: 'Managed worktree ID (required for diff, merge, remove).'
        },
        baseRef: {
          type: 'string',
          description: 'Base git ref or commit to branch from (defaults to HEAD).'
        },
        squash: {
          type: 'boolean',
          description: 'Use squash merge when merging a worktree back into the primary branch.'
        },
        commitMessage: {
          type: 'string',
          description: 'Optional commit message for auto-commit or squash merge.'
        },
        cleanup: {
          type: 'boolean',
          description: 'Remove the worktree and temporary branch after a clean merge.'
        },
        deleteBranch: {
          type: 'boolean',
          description: 'Delete the temporary worktree branch when removing (defaults to true).'
        }
      },
      required: ['action']
    }
  },

  async execute(args: GitWorktreeArgs = {}, context: ToolWorkspaceContext = {}): Promise<GitWorktreeResult> {
    try {
      const safeArgs = args && typeof args === 'object' ? args : {};
      const action = typeof safeArgs.action === 'string' ? safeArgs.action.trim().toLowerCase() : 'list';
      const scope = resolveToolWorkspaceRoots(context);
      const workspaceRoot = scope.primaryRoot || process.cwd();

      if (action === 'list') {
        const list = listWorktrees(workspaceRoot);
        return {
          success: true,
          output: JSON.stringify({
            total: list.length,
            managed: list.filter((w) => w.managed).length,
            worktrees: list
          }, null, 2)
        };
      }

      if (action === 'create') {
        const created = createWorktree(workspaceRoot, {
          name: safeArgs.name,
          baseRef: safeArgs.baseRef
        });
        return { success: true, output: JSON.stringify(created, null, 2) };
      }

      if (action === 'diff') {
        if (!safeArgs.worktreeId) return { success: false, error: 'worktreeId is required for action "diff".' };
        const report = inspectWorktreeDiff(workspaceRoot, safeArgs.worktreeId);
        return { success: true, output: JSON.stringify(report, null, 2) };
      }

      if (action === 'merge') {
        if (!safeArgs.worktreeId) return { success: false, error: 'worktreeId is required for action "merge".' };
        const merged = mergeWorktree(workspaceRoot, safeArgs.worktreeId, {
          squash: safeArgs.squash,
          commitMessage: safeArgs.commitMessage,
          cleanup: safeArgs.cleanup
        });
        return {
          success: merged.merged,
          output: JSON.stringify(merged, null, 2),
          ...(merged.error ? { error: merged.error } : {})
        };
      }

      if (action === 'remove') {
        if (!safeArgs.worktreeId) return { success: false, error: 'worktreeId is required for action "remove".' };
        const res = removeWorktree(workspaceRoot, safeArgs.worktreeId, {
          deleteBranch: safeArgs.deleteBranch
        });
        return { success: true, output: JSON.stringify(res, null, 2) };
      }

      if (action === 'prune') {
        const res = pruneManagedWorktrees(workspaceRoot);
        return { success: true, output: JSON.stringify(res, null, 2) };
      }

      return { success: false, error: `Unknown git.worktree action "${sanitizeToolText(action, 40)}".` };
    } catch (err: unknown) {
      return { success: false, error: sanitizeToolError(err) };
    }
  }
};
