/**
 * Causyne Agent — Persisted Same-Session Goal Loop State Machine & Tool
 *
 * Implements a CAS-revisioned multi-round goal tracker (`active | paused | blocked | complete`)
 * with strict safety invariants:
 *   - Durable state persisted atomically per session under `~/.causyne/goals/`.
 *   - Process-local `armed` / `disarmed` activation is NEVER persisted, so resumed
 *     or forked sessions never silently auto-drive without human confirmation.
 *   - Anti-premature-give-up gate rejects `blocked` before `minRoundsBeforeBlock`
 *     (default 3) consecutive rounds have been executed.
 *   - Subagents cannot create, pause, or resume top-level user goals.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWriteFileSync } from '../infra/atomicWriter.js';
import { causyneHome } from '../utils/paths.js';
import { boundedInteger, sanitizeToolError } from '../tools/toolPathSafety.js';
const DEFAULT_MAX_ROUNDS = 24;
const DEFAULT_MIN_ROUNDS_BEFORE_BLOCK = 3;
const SAFE_SESSION_KEY_RE = /[^a-zA-Z0-9_-]/g;
// Process-local activation map — intentionally never persisted to disk
const armedSessions = new Map();
function goalFilePath(sessionId) {
    const safeId = String(sessionId || 'default').replace(SAFE_SESSION_KEY_RE, '_').slice(0, 80) || 'default';
    return path.join(causyneHome(), 'goals', `${safeId}.json`);
}
function readPersistedGoal(sessionId) {
    const filePath = goalFilePath(sessionId);
    if (!fs.existsSync(filePath))
        return null;
    try {
        const stat = fs.lstatSync(filePath);
        if (stat.isSymbolicLink() || !stat.isFile())
            return null;
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!parsed || typeof parsed.id !== 'string' || typeof parsed.objective !== 'string')
            return null;
        return {
            id: parsed.id,
            sessionId: parsed.sessionId || sessionId,
            revision: Number.isInteger(parsed.revision) ? Number(parsed.revision) : 1,
            objective: parsed.objective,
            phase: parsed.phase === 'paused' || parsed.phase === 'blocked' || parsed.phase === 'complete' ? parsed.phase : 'active',
            roundsStarted: Number.isInteger(parsed.roundsStarted) ? Number(parsed.roundsStarted) : 0,
            consecutiveRounds: Number.isInteger(parsed.consecutiveRounds) ? Number(parsed.consecutiveRounds) : 0,
            maxRounds: Number.isInteger(parsed.maxRounds) ? Number(parsed.maxRounds) : DEFAULT_MAX_ROUNDS,
            minRoundsBeforeBlock: Number.isInteger(parsed.minRoundsBeforeBlock) ? Number(parsed.minRoundsBeforeBlock) : DEFAULT_MIN_ROUNDS_BEFORE_BLOCK,
            summary: typeof parsed.summary === 'string' ? parsed.summary : '',
            blocker: typeof parsed.blocker === 'string' ? parsed.blocker : '',
            createdAt: Number(parsed.createdAt || Date.now()),
            updatedAt: Number(parsed.updatedAt || Date.now())
        };
    }
    catch {
        return null;
    }
}
function writePersistedGoal(record) {
    const filePath = goalFilePath(record.sessionId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
}
function attachActivation(record) {
    const armed = armedSessions.get(record.sessionId);
    const isArmed = Boolean(record.phase === 'active'
        && armed
        && armed.goalId === record.id
        && armed.revision === record.revision);
    return { ...record, activation: isArmed ? 'armed' : 'disarmed' };
}
export class GoalManager {
    getGoal(sessionId) {
        const rec = readPersistedGoal(sessionId);
        return rec ? attachActivation(rec) : null;
    }
    createGoal(options) {
        const objective = String(options.objective || '').trim();
        if (!objective || objective.length > 4000) {
            throw new Error('Goal objective must contain 1-4000 characters.');
        }
        const now = Date.now();
        const record = {
            id: `goal_${crypto.randomBytes(6).toString('hex')}`,
            sessionId: options.sessionId,
            revision: 1,
            objective,
            phase: 'active',
            roundsStarted: 0,
            consecutiveRounds: 0,
            maxRounds: boundedInteger(options.maxRounds, DEFAULT_MAX_ROUNDS, 1, 256),
            minRoundsBeforeBlock: boundedInteger(options.minRoundsBeforeBlock, DEFAULT_MIN_ROUNDS_BEFORE_BLOCK, 1, 20),
            summary: '',
            blocker: '',
            createdAt: now,
            updatedAt: now
        };
        writePersistedGoal(record);
        if (options.arm !== false) {
            armedSessions.set(record.sessionId, { goalId: record.id, revision: record.revision });
        }
        else {
            armedSessions.delete(record.sessionId);
        }
        return attachActivation(record);
    }
    updateGoal(options) {
        const existing = readPersistedGoal(options.sessionId);
        if (options.action === 'clear') {
            armedSessions.delete(options.sessionId);
            const fp = goalFilePath(options.sessionId);
            if (fs.existsSync(fp))
                fs.unlinkSync(fp);
            return null;
        }
        if (!existing) {
            throw new Error('No active goal exists in this session.');
        }
        if (options.expectedRevision !== undefined && existing.revision !== options.expectedRevision) {
            throw new Error(`Goal revision conflict (expected ${options.expectedRevision}, actual ${existing.revision}).`);
        }
        const next = {
            ...existing,
            revision: existing.revision + 1,
            updatedAt: Date.now()
        };
        if (options.action === 'edit') {
            const objective = String(options.objective || '').trim();
            if (!objective || objective.length > 4000)
                throw new Error('Updated objective must contain 1-4000 characters.');
            next.objective = objective;
            next.consecutiveRounds = 0;
        }
        else if (options.action === 'pause') {
            next.phase = 'paused';
            armedSessions.delete(options.sessionId);
        }
        else if (options.action === 'resume') {
            if (existing.phase === 'paused' && options.isHumanInitiated !== true) {
                throw new Error('GOAL_TOOL_RESUME_PAUSED: Only a direct human turn can resume a paused goal.');
            }
            next.phase = 'active';
            next.blocker = '';
            armedSessions.set(options.sessionId, { goalId: next.id, revision: next.revision });
        }
        else if (options.action === 'advance') {
            if (existing.phase !== 'active')
                throw new Error(`Cannot advance goal in phase "${existing.phase}".`);
            if (existing.roundsStarted >= existing.maxRounds) {
                next.phase = 'blocked';
                next.blocker = `Reached round limit (${existing.maxRounds}).`;
                armedSessions.delete(options.sessionId);
            }
            else {
                next.roundsStarted += 1;
                next.consecutiveRounds += 1;
                armedSessions.set(options.sessionId, { goalId: next.id, revision: next.revision });
            }
        }
        else if (options.action === 'complete') {
            const summary = String(options.summary || '').trim();
            if (!summary)
                throw new Error('Completing a goal requires a grounded verification summary.');
            next.phase = 'complete';
            next.summary = summary.slice(0, 4000);
            next.blocker = '';
            armedSessions.delete(options.sessionId);
        }
        else if (options.action === 'blocked') {
            const blocker = String(options.blocker || '').trim();
            if (!blocker)
                throw new Error('Marking a goal blocked requires a concrete blocker description.');
            if (existing.consecutiveRounds < existing.minRoundsBeforeBlock && options.isHumanInitiated !== true) {
                throw new Error(`GOAL_TOOL_BLOCK_THRESHOLD: Cannot mark goal blocked after only ${existing.consecutiveRounds} round(s); `
                    + `at least ${existing.minRoundsBeforeBlock} consecutive rounds are required before giving up.`);
            }
            next.phase = 'blocked';
            next.blocker = blocker.slice(0, 2000);
            armedSessions.delete(options.sessionId);
        }
        writePersistedGoal(next);
        return attachActivation(next);
    }
}
export const goalManager = new GoalManager();
export const goalLoopTool = {
    schema: {
        name: 'goal',
        description: 'Manage a persistent, CAS-revisioned multi-round goal for the current session (status, create, edit, pause, resume, advance, complete, blocked, clear). Enforces anti-premature-block thresholds and non-persisted armed/disarmed activation safety.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['status', 'create', 'edit', 'pause', 'resume', 'advance', 'complete', 'blocked', 'clear']
                },
                objective: { type: 'string', description: 'Goal objective (required for create/edit).' },
                summary: { type: 'string', description: 'Grounded completion summary with verified evidence (required for complete).' },
                blocker: { type: 'string', description: 'Concrete blocker explanation (required for blocked).' },
                expectedRevision: { type: 'integer', description: 'Optional CAS revision guard.' },
                maxRounds: { type: 'integer', description: 'Maximum autonomous rounds (1-256, default 24).' }
            },
            required: ['action'],
            additionalProperties: false
        }
    },
    async execute(args, context = {}) {
        try {
            if (context.isSubagent) {
                return { success: false, error: 'Subagents cannot mutate top-level session goals.' };
            }
            const sessionId = context.parentLoop?.sessionId || context.parentLoop?.taskId || 'default';
            if (args.action === 'status') {
                const current = goalManager.getGoal(sessionId);
                return {
                    success: true,
                    goal: current,
                    output: current
                        ? `Goal ${current.id} (rev ${current.revision}, phase=${current.phase}, ${current.activation}, rounds=${current.roundsStarted}/${current.maxRounds}): ${current.objective}`
                        : 'No persisted goal for this session.'
                };
            }
            if (args.action === 'create') {
                const created = goalManager.createGoal({
                    sessionId,
                    objective: args.objective || '',
                    maxRounds: args.maxRounds
                });
                return {
                    success: true,
                    goal: created,
                    output: `Created goal ${created.id} (rev ${created.revision}, armed): ${created.objective}`
                };
            }
            const updated = goalManager.updateGoal({
                sessionId,
                action: args.action,
                expectedRevision: args.expectedRevision,
                objective: args.objective,
                summary: args.summary,
                blocker: args.blocker,
                isHumanInitiated: false
            });
            if (!updated) {
                return { success: true, goal: null, output: 'Cleared session goal.' };
            }
            return {
                success: true,
                goal: updated,
                output: `Updated goal ${updated.id} -> phase=${updated.phase} (rev ${updated.revision}, rounds=${updated.roundsStarted}/${updated.maxRounds})`
            };
        }
        catch (error) {
            return { success: false, error: sanitizeToolError(error) };
        }
    }
};
