/**
 * @file src/saveTools.ts
 * saveTools — stage 4 of the tool pipeline.
 *
 *   user intent -> ToolsList -> decideTools -> SmartTools -> saveTools -> AgentLoop
 *
 * Owns the set of tools admitted for a conversation. Admission is append-only
 * and ordered: tool schemas sit at the front of every provider's cached prefix,
 * so stable ordering avoids unnecessary prefix changes. Adding definitions can
 * still invalidate provider caches; savings must be measured, not assumed.
 *
 * The set is persisted per session so a resumed conversation starts with the
 * tools it already earned, instead of searching for them again.
 *
 * Authorship: Strict TypeScript (Causyne Agent).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from './utils/paths.js';
import { atomicWriteFileSync } from './infra/atomicWriter.js';
const MAX_NAMES = 10000;
const MAX_RECORDS = 50;
const MAX_FILES = 200;
const NAME = /^[A-Za-z0-9_.:@/-]{1,200}$/;
export class SavedTools {
    packs;
    tools;
    order;
    history = [];
    /** Passing existing collections lets a caller keep its own references valid. */
    constructor(shared = {}) {
        this.packs = shared.packs ?? new Set();
        this.tools = shared.tools ?? new Set();
        this.order = shared.order ?? [];
    }
    admitPack(name) {
        if (!name || this.packs.has(name))
            return false;
        this.packs.add(name);
        this.order.push(name);
        return true;
    }
    admitTool(name) {
        if (!name || this.tools.has(name))
            return false;
        this.tools.add(name);
        return true;
    }
    admit(refined) {
        const addedPacks = refined.packs.filter((name) => this.admitPack(name));
        const addedTools = refined.tools.filter((name) => this.admitTool(name));
        if (addedPacks.length > 0 || addedTools.length > 0) {
            this.history.push({ at: Date.now(), source: refined.source, tools: addedTools, packs: addedPacks, reasons: refined.reasons });
            if (this.history.length > MAX_RECORDS)
                this.history.splice(0, this.history.length - MAX_RECORDS);
        }
        return { addedTools, addedPacks };
    }
    records() {
        return this.history;
    }
    toState() {
        return { packs: [...this.packs], tools: [...this.tools], order: [...this.order] };
    }
    /** Restore without reordering what is already admitted. */
    restore(state) {
        const addedPacks = state.order.filter((name) => state.packs.includes(name) && this.admitPack(name));
        for (const name of state.packs)
            if (this.admitPack(name))
                addedPacks.push(name);
        const addedTools = state.tools.filter((name) => this.admitTool(name));
        return { addedTools, addedPacks };
    }
}
function directory() {
    const dir = path.join(causyneHome(), 'tool-sessions');
    try {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
        else {
            const mode = fs.statSync(dir).mode & 0o777;
            if ((mode & 0o100) === 0)
                fs.chmodSync(dir, 0o700);
        }
    }
    catch {
        // fallback if concurrent or read-only
    }
    return dir;
}
/** The session id is hashed so it can never escape the directory or collide with a path. */
export function savedToolsPath(sessionId) {
    const digest = createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 32);
    return path.join(directory(), `${digest}.json`);
}
function names(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === 'string' && NAME.test(item)).slice(0, MAX_NAMES);
}
/** Never throws: a missing or damaged file is the same as no saved tools. */
export function readSavedTools(sessionId) {
    try {
        const raw = JSON.parse(fs.readFileSync(savedToolsPath(sessionId), 'utf8'));
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
            return null;
        const record = raw;
        const state = { packs: names(record['packs']), tools: names(record['tools']), order: names(record['order']) };
        return state.packs.length + state.tools.length > 0 ? state : null;
    }
    catch {
        return null;
    }
}
function prune() {
    try {
        const entries = fs.readdirSync(directory())
            .filter((file) => file.endsWith('.json'))
            .map((file) => ({ file, at: fs.statSync(path.join(directory(), file)).mtimeMs }))
            .sort((a, b) => b.at - a.at);
        for (const stale of entries.slice(MAX_FILES))
            fs.rmSync(path.join(directory(), stale.file), { force: true });
    }
    catch {
        // housekeeping must never block a task
    }
}
/** Never throws: persistence is an optimisation, not a dependency. */
export function writeSavedTools(sessionId, state) {
    try {
        const bounded = {
            packs: names(state.packs),
            tools: names(state.tools),
            order: names(state.order)
        };
        fs.mkdirSync(directory(), { recursive: true, mode: 0o700 });
        atomicWriteFileSync(savedToolsPath(sessionId), JSON.stringify(bounded), { mode: 0o600 });
        prune();
        return true;
    }
    catch {
        return false;
    }
}
