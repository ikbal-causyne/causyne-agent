import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from './utils/paths.js';
const BUFFER_DIR = path.join(causyneHome(), 'buffers');
export class TaskBuffer {
    constructor() {
        this.ensureDir();
    }
    ensureDir() {
        if (!fs.existsSync(BUFFER_DIR)) {
            fs.mkdirSync(BUFFER_DIR, { recursive: true });
        }
    }
    getBufferPath(taskId) {
        return path.join(BUFFER_DIR, `${taskId}.jsonl`);
    }
    async appendOutput(taskId, stepData) {
        const file = this.getBufferPath(taskId);
        const entry = JSON.stringify({ ts: Date.now(), ...stepData }) + '\n';
        fs.appendFileSync(file, entry);
    }
    async getBuffer(taskId) {
        const file = this.getBufferPath(taskId);
        if (!fs.existsSync(file))
            return [];
        const content = fs.readFileSync(file, 'utf8');
        return content.split('\n')
            .filter(l => l.trim())
            .map(l => JSON.parse(l));
    }
    async clearBuffer(taskId) {
        const file = this.getBufferPath(taskId);
        if (fs.existsSync(file)) {
            fs.unlinkSync(file);
        }
    }
}
