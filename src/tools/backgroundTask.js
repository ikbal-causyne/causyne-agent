/**
 * Causyne Agent — Managed Background Task Tool (`task.bg`)
 */
import { backgroundTaskManager } from '../backgroundTasks.js';
import { boundedInteger, resolveScopedPath, resolveToolWorkspaceRoots, sanitizeToolError, sanitizeToolText } from './toolPathSafety.js';
export const backgroundTaskTool = {
    schema: {
        name: 'task.bg',
        description: 'Manage OS-sandboxed background workspace tasks (start, list, status, output, wait, stop) with incremental offset log streaming and clean shutdown.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['start', 'list', 'status', 'output', 'wait', 'stop'],
                    description: 'Background task operation to perform.'
                },
                command: { type: 'string', description: 'Shell command to launch (required for start).' },
                label: { type: 'string', description: 'Short label for the task (for start).' },
                cwd: { type: 'string', description: 'Optional working directory inside workspace (for start).' },
                taskId: { type: 'string', description: 'Task identifier (required for status, output, wait, stop).' },
                offset: { type: 'integer', description: 'Byte/char offset for incremental log reads (for output).' },
                timeoutMs: { type: 'integer', description: 'Max milliseconds to wait (for wait, default 15000).' }
            },
            required: ['action']
        }
    },
    async execute(args = {}, context = {}) {
        try {
            const safeArgs = args && typeof args === 'object' ? args : {};
            const action = typeof safeArgs.action === 'string' ? safeArgs.action.trim().toLowerCase() : 'list';
            const scope = resolveToolWorkspaceRoots(context);
            const workspaceRoot = scope.primaryRoot || process.cwd();
            if (action === 'list') {
                const list = backgroundTaskManager.list();
                return { success: true, output: JSON.stringify({ total: list.length, tasks: list }, null, 2) };
            }
            if (action === 'start') {
                if (typeof safeArgs.command !== 'string' || !safeArgs.command.trim()) {
                    return { success: false, error: 'task.bg start requires a non-empty command.' };
                }
                const cwd = typeof safeArgs.cwd === 'string' && safeArgs.cwd.trim()
                    ? resolveScopedPath(safeArgs.cwd, context)
                    : workspaceRoot;
                const ctxRecord = context;
                const osSandbox = ctxRecord.osSandbox
                    ?? (typeof ctxRecord.parentLoop?.config?.osSandbox === 'string' ? ctxRecord.parentLoop.config.osSandbox : undefined);
                const started = backgroundTaskManager.start({
                    command: safeArgs.command,
                    cwd,
                    workspaceRoots: scope.roots.length > 0 ? scope.roots : [cwd],
                    label: safeArgs.label,
                    osSandbox
                });
                return { success: true, output: JSON.stringify(started, null, 2) };
            }
            const taskId = typeof safeArgs.taskId === 'string' ? safeArgs.taskId.trim() : '';
            if (!taskId)
                return { success: false, error: `task.bg "${action}" requires a taskId.` };
            if (action === 'status') {
                const snap = backgroundTaskManager.status(taskId);
                if (!snap)
                    return { success: false, error: `Background task "${sanitizeToolText(taskId, 64)}" not found.` };
                return { success: true, output: JSON.stringify(snap, null, 2) };
            }
            if (action === 'output') {
                const offset = boundedInteger(safeArgs.offset, 0, 0, 10_000_000);
                const res = backgroundTaskManager.readOutput(taskId, offset);
                return { success: true, output: JSON.stringify(res, null, 2) };
            }
            if (action === 'wait') {
                const timeoutMs = boundedInteger(safeArgs.timeoutMs, 15_000, 50, 120_000);
                const snap = await backgroundTaskManager.wait(taskId, timeoutMs);
                return { success: true, output: JSON.stringify(snap, null, 2) };
            }
            if (action === 'stop') {
                const snap = backgroundTaskManager.stop(taskId);
                return { success: true, output: JSON.stringify(snap, null, 2) };
            }
            return { success: false, error: `Unknown task.bg action "${sanitizeToolText(action, 40)}".` };
        }
        catch (err) {
            return { success: false, error: sanitizeToolError(err) };
        }
    }
};
