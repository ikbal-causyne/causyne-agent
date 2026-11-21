import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from './utils/paths.js';
function bufferDir() {
    return path.join(causyneHome(), 'buffers');
}
export class TaskBuffer {
    constructor() {
        this.ensureDir();
    }
    ensureDir() {
        const dir = bufferDir();
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
    getBufferPath(taskId) {
        return path.join(bufferDir(), `${taskId}.jsonl`);
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
