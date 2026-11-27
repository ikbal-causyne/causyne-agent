/**
 * Causyne Agent — Durable Zero-Dependency Task Scheduler & Tool
 *
 * Pure Strict TypeScript scheduler supporting `after`, `at`, `every` (>=60s),
 * `daily`, `weekly`, and 5-field Vixie `cron` schedules evaluated with built-in
 * `Intl.DateTimeFormat` IANA timezone math (zero external polyfills/packages).
 *
 * Operational invariants:
 *   - Atomic JSON persistence under `~/.causyne/schedules.json`.
 *   - Optimistic concurrency (`expectedUpdatedAt` -> `schedule_conflict`).
 *   - Missed-occurrence coalescing (never storms after laptop sleep/downtime).
 *   - Subagent refusal (only top-level user sessions can mutate schedules).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWriteFileSync } from '../infra/atomicWriter.js';
import { causyneHome } from '../utils/paths.js';
import { boundedInteger, sanitizeToolError } from '../tools/toolPathSafety.js';
const STORE_VERSION = 1;
const MIN_INTERVAL_SEC = 60;
const MAX_TASKS = 100;
function storeFilePath() {
    return path.join(causyneHome(), 'schedules.json');
}
function readStore() {
    const fp = storeFilePath();
    if (!fs.existsSync(fp))
        return { version: STORE_VERSION, tasks: [] };
    try {
        const stat = fs.lstatSync(fp);
        if (stat.isSymbolicLink() || !stat.isFile())
            return { version: STORE_VERSION, tasks: [] };
        const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
        const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
        return { version: STORE_VERSION, tasks };
    }
    catch {
        return { version: STORE_VERSION, tasks: [] };
    }
}
function writeStore(store) {
    const fp = storeFilePath();
    fs.mkdirSync(path.dirname(fp), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(fp, `${JSON.stringify(store, null, 2)}\n`);
}
function validateTimezone(tz) {
    const candidate = typeof tz === 'string' && tz.trim() ? tz.trim() : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: candidate });
        return candidate;
    }
    catch {
        throw new Error(`Invalid IANA timezone: "${candidate}".`);
    }
}
function parseCronField(expr, min, max) {
    const values = new Set();
    const parts = expr.split(',');
    for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed)
            throw new Error(`Empty cron segment in "${expr}".`);
        const [rangePart, stepPart] = trimmed.split('/');
        const step = stepPart !== undefined ? Number.parseInt(stepPart, 10) : 1;
        if (!Number.isInteger(step) || step <= 0)
            throw new Error(`Invalid cron step in "${trimmed}".`);
        let start = min;
        let end = max;
        if (rangePart !== '*') {
            if (rangePart.includes('-')) {
                const [a, b] = rangePart.split('-');
                start = Number.parseInt(a || '', 10);
                end = Number.parseInt(b || '', 10);
            }
            else {
                start = Number.parseInt(rangePart, 10);
                end = stepPart !== undefined ? max : start;
            }
        }
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
            throw new Error(`Out-of-range cron field "${trimmed}" (expected ${min}-${max}).`);
        }
        for (let v = start; v <= end; v += step)
            values.add(v);
    }
    return values;
}
function getZonedParts(epochMs, timeZone) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        weekday: 'short',
        hourCycle: 'h23'
    });
    const parts = fmt.formatToParts(new Date(epochMs));
    const map = {};
    for (const p of parts)
        map[p.type] = p.value;
    const weekdayNames = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
        minute: Number.parseInt(map.minute || '0', 10),
        hour: Number.parseInt(map.hour || '0', 10) % 24,
        day: Number.parseInt(map.day || '1', 10),
        month: Number.parseInt(map.month || '1', 10),
        weekday: weekdayNames[map.weekday || 'Sun'] ?? 0
    };
}
/**
 * Computes the next scheduled UTC epoch timestamp (ms) strictly after `fromMs`.
 * Coalesces missed past occurrences automatically by scanning forward from `fromMs`.
 */
export function computeNextRunAt(kind, spec, timezone, fromMs = Date.now()) {
    const tz = validateTimezone(timezone);
    const raw = String(spec || '').trim();
    if (kind === 'after') {
        const secs = Number.parseInt(raw, 10);
        if (!Number.isInteger(secs) || secs < 10 || secs > 365 * 86_400) {
            throw new Error('`after` spec must be a delay in seconds (10 to 31536000).');
        }
        return fromMs + secs * 1000;
    }
    if (kind === 'at') {
        const parsed = Date.parse(raw);
        if (!Number.isFinite(parsed))
            throw new Error('`at` spec must be a valid ISO-8601 timestamp.');
        if (parsed <= fromMs)
            throw new Error('`at` timestamp must be in the future.');
        return parsed;
    }
    if (kind === 'every') {
        const secs = Number.parseInt(raw, 10);
        if (!Number.isInteger(secs) || secs < MIN_INTERVAL_SEC || secs > 30 * 86_400) {
            throw new Error(`\`every\` spec must be an interval in seconds (${MIN_INTERVAL_SEC} to 2592000).`);
        }
        return fromMs + secs * 1000;
    }
    let cronExpr = raw;
    if (kind === 'daily') {
        const m = /^(\d{1,2}):(\d{2})$/.exec(raw);
        if (!m)
            throw new Error('`daily` spec must be HH:MM (24-hour).');
        const hh = Number.parseInt(m[1], 10);
        const mm = Number.parseInt(m[2], 10);
        if (hh < 0 || hh > 23 || mm < 0 || mm > 59)
            throw new Error('`daily` time out of range.');
        cronExpr = `${mm} ${hh} * * *`;
    }
    else if (kind === 'weekly') {
        const m = /^(sun|mon|tue|wed|thu|fri|sat)\s+(\d{1,2}):(\d{2})$/i.exec(raw);
        if (!m)
            throw new Error('`weekly` spec must be "<day> HH:MM", e.g. "mon 09:00".');
        const dayMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
        const dow = dayMap[m[1].toLowerCase()];
        const hh = Number.parseInt(m[2], 10);
        const mm = Number.parseInt(m[3], 10);
        if (hh < 0 || hh > 23 || mm < 0 || mm > 59)
            throw new Error('`weekly` time out of range.');
        cronExpr = `${mm} ${hh} * * ${dow}`;
    }
    const fields = cronExpr.split(/\s+/);
    if (fields.length !== 5) {
        throw new Error('`cron` spec must have exactly 5 fields: minute hour day-of-month month day-of-week.');
    }
    const minutes = parseCronField(fields[0], 0, 59);
    const hours = parseCronField(fields[1], 0, 23);
    const days = parseCronField(fields[2], 1, 31);
    const months = parseCronField(fields[3], 1, 12);
    const rawDows = parseCronField(fields[4], 0, 7);
    if (rawDows.has(7)) {
        rawDows.delete(7);
        rawDows.add(0);
    }
    // Advance minute-by-minute up to 366 days (fast short-circuit by hour/day)
    let probe = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
    const maxProbe = fromMs + 366 * 86_400_000;
    while (probe <= maxProbe) {
        const zp = getZonedParts(probe, tz);
        if (!months.has(zp.month)) {
            probe += 24 * 60 * 60_000;
            continue;
        }
        if (!days.has(zp.day) || !rawDows.has(zp.weekday)) {
            probe += 60 * 60_000;
            continue;
        }
        if (!hours.has(zp.hour)) {
            probe += 60_000;
            continue;
        }
        if (minutes.has(zp.minute)) {
            return probe;
        }
        probe += 60_000;
    }
    throw new Error('Could not find next occurrence within 366 days for cron expression.');
}
export class DurableScheduler {
    list(workspaceRoot) {
        const store = readStore();
        return workspaceRoot
            ? store.tasks.filter((t) => t.workspaceRoot === workspaceRoot)
            : store.tasks;
    }
    get(id) {
        return readStore().tasks.find((t) => t.id === id) ?? null;
    }
    create(options) {
        const store = readStore();
        if (store.tasks.length >= MAX_TASKS) {
            throw new Error(`Maximum scheduled tasks (${MAX_TASKS}) reached.`);
        }
        const name = String(options.name || '').trim().slice(0, 80);
        const prompt = String(options.prompt || '').trim().slice(0, 4000);
        if (!name || !prompt)
            throw new Error('Both name and prompt are required.');
        const timezone = validateTimezone(options.timezone);
        const now = Date.now();
        const nextRunAt = computeNextRunAt(options.kind, options.spec, timezone, now);
        const record = {
            id: `sched_${crypto.randomBytes(6).toString('hex')}`,
            name,
            prompt,
            workspaceRoot: options.workspaceRoot,
            kind: options.kind,
            spec: options.spec.trim(),
            timezone,
            status: 'active',
            nextRunAt,
            lastRunAt: null,
            runCount: 0,
            createdAt: now,
            updatedAt: now
        };
        store.tasks.push(record);
        writeStore(store);
        return record;
    }
    edit(options) {
        const store = readStore();
        const idx = store.tasks.findIndex((t) => t.id === options.id);
        if (idx === -1)
            throw new Error(`Schedule "${options.id}" not found.`);
        const existing = store.tasks[idx];
        if (options.expectedUpdatedAt !== undefined && existing.updatedAt !== options.expectedUpdatedAt) {
            throw new Error(`schedule_conflict: Schedule "${options.id}" was modified concurrently.`);
        }
        if (options.action === 'delete') {
            store.tasks.splice(idx, 1);
            writeStore(store);
            return null;
        }
        const now = Date.now();
        const updated = { ...existing, updatedAt: now };
        if (options.action === 'pause') {
            updated.status = 'paused';
        }
        else if (options.action === 'resume') {
            updated.status = 'active';
            updated.nextRunAt = computeNextRunAt(updated.kind, updated.spec, updated.timezone, now);
        }
        else if (options.action === 'update') {
            if (typeof options.prompt === 'string' && options.prompt.trim()) {
                updated.prompt = options.prompt.trim().slice(0, 4000);
            }
            if (typeof options.timezone === 'string' && options.timezone.trim()) {
                updated.timezone = validateTimezone(options.timezone);
            }
            if (typeof options.spec === 'string' && options.spec.trim()) {
                updated.spec = options.spec.trim();
            }
            if (updated.status === 'active') {
                updated.nextRunAt = computeNextRunAt(updated.kind, updated.spec, updated.timezone, now);
            }
        }
        store.tasks[idx] = updated;
        writeStore(store);
        return updated;
    }
}
export const durableScheduler = new DurableScheduler();
export const scheduleTool = {
    schema: {
        name: 'schedule',
        description: 'Create, list, view, pause, resume, update, or delete durable scheduled tasks (`after`, `at`, `every`, `daily`, `weekly`, or 5-field `cron` with IANA timezone). Enforces optimistic concurrency and subagent safety.',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['create', 'list', 'view', 'pause', 'resume', 'update', 'delete'] },
                id: { type: 'string', description: 'Schedule ID for view/pause/resume/update/delete.' },
                name: { type: 'string', description: 'Short task title (for create).' },
                prompt: { type: 'string', description: 'Prompt instruction to execute on schedule.' },
                kind: { type: 'string', enum: ['after', 'at', 'every', 'daily', 'weekly', 'cron'] },
                spec: {
                    type: 'string',
                    description: 'Schedule specification (seconds for after/every, ISO timestamp for at, HH:MM for daily, "mon 09:00" for weekly, or 5-field cron).'
                },
                timezone: { type: 'string', description: 'Optional IANA timezone (e.g. "UTC", "Asia/Jakarta", "America/New_York").' },
                expectedUpdatedAt: { type: 'integer', description: 'Optional optimistic concurrency timestamp guard.' }
            },
            required: ['action'],
            additionalProperties: false
        }
    },
    async execute(args, context = {}) {
        try {
            if (context.isSubagent && args.action !== 'list' && args.action !== 'view') {
                return { success: false, error: 'Subagents are not permitted to create or modify durable schedules.' };
            }
            const workspaceRoot = context.workspaceRoot || context.workspacePaths?.[0] || process.cwd();
            if (args.action === 'list') {
                const tasks = durableScheduler.list(workspaceRoot);
                return {
                    success: true,
                    tasks,
                    output: tasks.length === 0
                        ? 'No scheduled tasks in this workspace.'
                        : tasks.map((t) => `${t.id} [${t.status}] ${t.name} (${t.kind}: ${t.spec}, tz=${t.timezone}, next=${t.nextRunAt ? new Date(t.nextRunAt).toISOString() : 'none'})`).join('\n')
                };
            }
            if (args.action === 'view') {
                const task = args.id ? durableScheduler.get(args.id) : null;
                if (!task)
                    return { success: false, error: `Schedule "${args.id || ''}" not found.` };
                return { success: true, task, output: JSON.stringify(task, null, 2) };
            }
            if (args.action === 'create') {
                if (!args.kind || !args.spec)
                    return { success: false, error: 'kind and spec are required to create a schedule.' };
                const created = durableScheduler.create({
                    name: args.name || 'Scheduled task',
                    prompt: args.prompt || '',
                    workspaceRoot,
                    kind: args.kind,
                    spec: args.spec,
                    timezone: args.timezone
                });
                return {
                    success: true,
                    task: created,
                    output: `Created schedule ${created.id} (${created.kind}: ${created.spec}, next run ${created.nextRunAt ? new Date(created.nextRunAt).toISOString() : 'none'}).`
                };
            }
            if (!args.id)
                return { success: false, error: 'id is required for this schedule action.' };
            const updated = durableScheduler.edit({
                id: args.id,
                action: args.action,
                expectedUpdatedAt: args.expectedUpdatedAt,
                prompt: args.prompt,
                spec: args.spec,
                timezone: args.timezone
            });
            if (!updated)
                return { success: true, deleted: true, output: `Deleted schedule ${args.id}.` };
            return {
                success: true,
                task: updated,
                output: `Updated schedule ${updated.id} -> status=${updated.status}, next=${updated.nextRunAt ? new Date(updated.nextRunAt).toISOString() : 'none'}.`
            };
        }
        catch (error) {
            return { success: false, error: sanitizeToolError(error) };
        }
    }
};
// Keep boundedInteger export-clean if referenced externally
void boundedInteger;
