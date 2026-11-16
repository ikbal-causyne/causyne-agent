import fs from 'fs';
import path from 'path';
import { causyneHome } from './utils/paths.js';
import { formatMemoryContext, normalizeMemoryData, recordScopedFact } from './memory/scopedFacts.js';

const MEMORY_FILE_PATH = path.join(causyneHome(), 'memory.json');

// Ensure the directory and file exist
function initMemory() {
    const dir = path.dirname(MEMORY_FILE_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(MEMORY_FILE_PATH)) {
        fs.writeFileSync(MEMORY_FILE_PATH, JSON.stringify({ facts: [] }, null, 2));
    }
}

export function getMemory() {
    try {
        initMemory();
        const data = fs.readFileSync(MEMORY_FILE_PATH, 'utf-8');
        return normalizeMemoryData(JSON.parse(data));
    } catch (e) {
        console.error("Failed to read memory.json:", e.message);
        return { facts: [] };
    }
}

export function saveMemory(data) {
    try {
        initMemory();
        fs.writeFileSync(MEMORY_FILE_PATH, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error("Failed to write memory.json:", e.message);
    }
}

export function addFact(factStr, options = {}) {
    const mem = getMemory();
    const { memory, alreadyKnown } = recordScopedFact(mem, factStr, options);
    if (!alreadyKnown || options.workspace) {
        saveMemory(memory);
    }
}

export function clearMemory() {
    try {
        initMemory();
        fs.writeFileSync(MEMORY_FILE_PATH, JSON.stringify({ facts: [], entries: [] }, null, 2));
    } catch (e) {
        console.error("Failed to clear memory:", e.message);
    }
}

export function getMemoryContextString(options = undefined) {
    const mem = getMemory();
    return formatMemoryContext(mem, options);
}
