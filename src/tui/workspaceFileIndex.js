/**
 * Causyne: bounded, asynchronous, workspace-scoped index for @ references.
 * This module never follows symlinks or invokes external binaries.
 * It indexes nested project paths once, not on each keystroke.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
const SKIP = new Set([
    '.git', '.causyne', 'node_modules', '.next', '.nuxt', '.svelte-kit',
    '.venv', 'venv', '__pycache__', '.gradle', '.idea', '.cache',
    'coverage', 'vendor', 'Pods', 'dist', 'build', 'out', 'target'
]);
const DEFAULT_MAX_ENTRIES = 100_000;
const DEFAULT_MAX_DIRS = 20_000;
const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_REFRESH_MS = 45_000;
const YIELD_EVERY = 48;
function finiteInt(value, fallback, minimum = 1) {
    return Number.isSafeInteger(value) && value !== undefined && value >= minimum ? value : fallback;
}
/** Terminal control codes must never be inserted into a selectable path. */
function safeRelative(relative) {
    return relative.length > 0 && relative.length <= 4096
        && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(relative);
}
export class WorkspaceFileIndex {
    root;
    entries = null;
    truncated = false;
    indexed = [];
    listeners = new Set();
    building = null;
    generation = 0;
    completedAt = 0;
    disposed = false;
    maxEntries;
    maxDirs;
    maxDepth;
    refreshMs;
    constructor(root, options = {}) {
        this.root = path.resolve(root);
        this.maxEntries = finiteInt(options.maxEntries, DEFAULT_MAX_ENTRIES);
        this.maxDirs = finiteInt(options.maxDirs, DEFAULT_MAX_DIRS);
        this.maxDepth = finiteInt(options.maxDepth, DEFAULT_MAX_DEPTH);
        this.refreshMs = finiteInt(options.refreshMs, DEFAULT_REFRESH_MS, 0);
    }
    get isReady() { return this.entries !== null; }
    get isBuilding() { return this.building !== null; }
    subscribe(listener) {
        if (this.disposed)
            return () => { };
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }
    invalidate() { this.completedAt = 0; }
    dispose() {
        this.disposed = true;
        this.generation++;
        this.listeners.clear();
    }
    /**
     * Starts a scan only when required. Existing results remain available while
     * a TTL refresh runs. Consumers receive one event when the snapshot changes.
     */
    ensure(force = false) {
        if (this.disposed)
            return Promise.resolve(this.entries ?? []);
        if (this.building)
            return this.building;
        if (!force && this.entries && Date.now() - this.completedAt < this.refreshMs) {
            return Promise.resolve(this.entries);
        }
        const generation = ++this.generation;
        this.building = this.scan(generation)
            .then(({ entries, truncated }) => {
            if (this.disposed || generation !== this.generation)
                return this.entries ?? [];
            this.entries = entries;
            this.indexed = entries.map(value => ({ value, folded: value.toLocaleLowerCase() }));
            this.truncated = truncated;
            this.completedAt = Date.now();
            for (const listener of [...this.listeners]) {
                try {
                    listener();
                }
                catch { /* UI listeners cannot fail the index */ }
            }
            return entries;
        })
            .catch(() => {
            // Keep any previous snapshot if the root becomes unreadable.
            if (!this.disposed && generation === this.generation && this.entries === null) {
                this.entries = [];
                this.indexed = [];
                this.completedAt = Date.now();
                for (const listener of [...this.listeners]) {
                    try {
                        listener();
                    }
                    catch { /* never propagate to keyboard handling */ }
                }
            }
            return this.entries ?? [];
        })
            .finally(() => { if (generation === this.generation)
            this.building = null; });
        return this.building;
    }
    /** Contiguous matches take priority; fuzzy matching remains the JS fallback. */
    candidates(query) {
        if (!query)
            return this.entries ?? [];
        const needle = query.toLocaleLowerCase();
        const direct = this.indexed.filter(entry => entry.folded.includes(needle));
        return (direct.length > 0 ? direct.map(entry => entry.value) : this.entries ?? []);
    }
    async scan(generation) {
        const found = [];
        const queue = [
            { absolute: this.root, relative: '', depth: 0 }
        ];
        let cursor = 0;
        let truncated = false;
        while (cursor < queue.length) {
            if (this.disposed || generation !== this.generation)
                break;
            if (cursor >= this.maxDirs || found.length >= this.maxEntries) {
                truncated = true;
                break;
            }
            const current = queue[cursor++];
            if (!current)
                break;
            let listing;
            try {
                listing = await readdir(current.absolute, { withFileTypes: true });
            }
            catch {
                continue;
            }
            listing.sort((a, b) => a.name.localeCompare(b.name));
            for (const entry of listing) {
                if (this.disposed || generation !== this.generation)
                    break;
                if (entry.isSymbolicLink())
                    continue;
                if (!entry.isFile() && !entry.isDirectory())
                    continue;
                const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
                if (!safeRelative(relative))
                    continue;
                if (entry.isDirectory()) {
                    if (SKIP.has(entry.name))
                        continue;
                    if (current.depth < this.maxDepth) {
                        if (queue.length >= this.maxDirs)
                            truncated = true;
                        else
                            queue.push({
                                absolute: path.join(current.absolute, entry.name),
                                relative, depth: current.depth + 1
                            });
                    }
                    else
                        truncated = true;
                    found.push(`${relative}/`);
                }
                else {
                    found.push(relative);
                }
                if (found.length >= this.maxEntries) {
                    truncated = true;
                    break;
                }
            }
            // Periodically yield: typing, rendering and cancellation must remain responsive.
            if (cursor % YIELD_EVERY === 0) {
                await new Promise(resolve => setImmediate(resolve));
            }
        }
        return { entries: found, truncated };
    }
}
