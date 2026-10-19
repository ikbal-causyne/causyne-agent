import fs from 'fs';
import path from 'path';
import os from 'os';
import { causyneHome } from './utils/paths.js';

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
        return JSON.parse(data);
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

export function addFact(factStr) {
    const mem = getMemory();
    // Only add if it doesn't already exist to avoid duplicates
    if (!mem.facts.includes(factStr)) {
        mem.facts.push(factStr);
        saveMemory(mem);
    }
}

export function clearMemory() {
    try {
        initMemory();
        fs.writeFileSync(MEMORY_FILE_PATH, JSON.stringify({ facts: [] }, null, 2));
    } catch (e) {
        console.error("Failed to clear memory:", e.message);
    }
}

export function getMemoryContextString() {
    const mem = getMemory();
    if (!mem || !mem.facts || mem.facts.length === 0) return "No prior memory facts available.";
    
    return mem.facts.map((fact, index) => `${index + 1}. ${fact}`).join("\n");
}
