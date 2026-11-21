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
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    safeTaskId(taskId) {
        const cleaned = String(taskId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+/, '');
        return cleaned.length > 0 ? cleaned.slice(0, 64) : 'default';
    }
    getBufferPath(taskId) {
        const dir = path.resolve(bufferDir());
        const target = path.resolve(dir, `${this.safeTaskId(taskId)}.jsonl`);
        const rel = path.relative(dir, target);
        if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
            throw new Error('Invalid task buffer identifier');
        }
        return target;
    }
    async appendOutput(taskId, stepData) {
        this.ensureDir();
        const file = this.getBufferPath(taskId);
        try {
            const stat = fs.lstatSync(file);
            if (stat.isSymbolicLink() || !stat.isFile())
                return;
        }
        catch (err) {
            if (err?.code !== 'ENOENT')
                throw err;
        }
        const payload = stepData && typeof stepData === 'object' ? stepData : { value: stepData };
        let serialized;
        try {
            serialized = JSON.stringify({ ts: Date.now(), ...payload });
        }
        catch {
            serialized = JSON.stringify({ ts: Date.now(), error: 'unserializable_step_data' });
        }
        const MAX_STEP_JSON_BYTES = 512 * 1024;
        if (serialized.length > MAX_STEP_JSON_BYTES) {
            serialized = JSON.stringify({ ts: Date.now(), truncated: true, preview: serialized.slice(0, 4096) });
        }
        fs.appendFileSync(file, serialized + '\n', { mode: 0o600 });
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
