import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from './utils/paths.js';
const ROOT = path.join(causyneHome(), 'subagents');
const SAFE_ID = /^sub_[a-zA-Z0-9_-]{1,120}$/;
const MAX_MESSAGES = 500;
const MAX_CONTENT_BYTES = 128 * 1024;
const MAX_EVENT_BYTES = 512 * 1024;
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
function ensureRoot() {
    if (!fs.existsSync(ROOT))
        fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
}
function safeId(value) {
    const id = String(value ?? '');
    return SAFE_ID.test(id) ? id : null;
}
export function subagentJournalFile(id) {
    const safe = safeId(id);
    return safe ? path.join(ROOT, `${safe}.jsonl`) : null;
}
function boundedText(value, maximumBytes) {
    const text = String(value ?? '');
    if (Buffer.byteLength(text, 'utf8') <= maximumBytes)
        return text;
    let end = Math.min(text.length, maximumBytes);
    while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maximumBytes)
        end -= 1;
    return `${text.slice(0, end)}\n[truncated by Causyne]`;
}
function boundedMessage(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return null;
    const input = value;
    if (typeof input.role !== 'string')
        return null;
    let content = input.content;
    if (typeof content === 'string') {
        content = boundedText(content, MAX_CONTENT_BYTES);
    }
    else {
        try {
            const serialized = JSON.stringify(content);
            content = Buffer.byteLength(serialized, 'utf8') <= MAX_CONTENT_BYTES
                ? JSON.parse(serialized)
                : '[structured content omitted: exceeds sidechain limit]';
        }
        catch {
            content = '[unserializable content omitted]';
        }
    }
    const message = { role: input.role, content };
    for (const key of ['name', 'tool_call_id']) {
        if (typeof input[key] === 'string')
            message[key] = input[key];
    }
    return message;
}
function appendEvent(file, event) {
    try {
        const line = `${JSON.stringify(event)}\n`;
        if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_BYTES)
            return false;
        fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600, flag: 'a' });
        return true;
    }
    catch {
        return false;
    }
}
export function startSubagentJournal(input) {
    const file = subagentJournalFile(input.subagentId);
    if (!file)
        return false;
    try {
        ensureRoot();
        const event = {
            version: 1,
            type: 'subagent.started',
            at: Date.now(),
            subagentId: input.subagentId,
            name: boundedText(input.name, 256),
            prompt: boundedText(input.prompt, 32 * 1024),
            profile: input.profile ?? null,
            toolScope: input.toolScope.slice(0, 64),
            maxSteps: input.maxSteps,
            maxTokens: input.maxTokens
        };
        fs.writeFileSync(file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        return true;
    }
    catch {
        return false;
    }
}
export function completeSubagentJournal(id, messages, result) {
    const file = subagentJournalFile(id);
    if (!file || !fs.existsSync(file))
        return false;
    let ok = true;
    for (const value of messages.slice(-MAX_MESSAGES)) {
        const message = boundedMessage(value);
        if (!message)
            continue;
        ok = appendEvent(file, { version: 1, type: 'message.recorded', at: Date.now(), message }) && ok;
    }
    return appendEvent(file, {
        version: 1,
        type: 'subagent.completed',
        at: Date.now(),
        result
    }) && ok;
}
export function failSubagentJournal(id, error) {
    const file = subagentJournalFile(id);
    if (!file || !fs.existsSync(file))
        return false;
    return appendEvent(file, {
        version: 1,
        type: 'subagent.failed',
        at: Date.now(),
        error: boundedText(error, 8 * 1024)
    });
}
export function readSubagentJournal(id) {
    const file = subagentJournalFile(id);
    if (!file)
        return null;
    const requestedId = safeId(id);
    if (!requestedId)
        return null;
    try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > MAX_JOURNAL_BYTES)
            return null;
        const text = fs.readFileSync(file, 'utf8');
        const trailingNewline = text.endsWith('\n');
        const lines = text.split('\n');
        if (lines.at(-1) === '')
            lines.pop();
        let projection = null;
        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            if (!line)
                continue;
            let event;
            try {
                event = JSON.parse(line);
            }
            catch {
                if (index === lines.length - 1 && !trailingNewline)
                    break;
                return null;
            }
            if (event === null || typeof event !== 'object' || Array.isArray(event))
                return null;
            const record = event;
            if (record.version !== 1 || typeof record.type !== 'string' || typeof record.at !== 'number')
                return null;
            if (record.type === 'subagent.started') {
                if (projection
                    || typeof record.subagentId !== 'string'
                    || record.subagentId !== requestedId
                    || typeof record.name !== 'string'
                    || typeof record.prompt !== 'string'
                    || !Array.isArray(record.toolScope)
                    || typeof record.maxSteps !== 'number'
                    || typeof record.maxTokens !== 'number')
                    return null;
                projection = {
                    subagentId: record.subagentId,
                    name: record.name,
                    prompt: record.prompt,
                    profile: typeof record.profile === 'string' ? record.profile : null,
                    toolScope: record.toolScope.filter((tool) => typeof tool === 'string'),
                    maxSteps: record.maxSteps,
                    maxTokens: record.maxTokens,
                    startedAt: record.at,
                    updatedAt: record.at,
                    status: 'running',
                    messages: [],
                    result: null,
                    error: null
                };
                continue;
            }
            if (!projection)
                return null;
            projection.updatedAt = record.at;
            if (record.type === 'message.recorded') {
                if (record.message === null || typeof record.message !== 'object' || Array.isArray(record.message))
                    return null;
                projection.messages.push(record.message);
            }
            else if (record.type === 'subagent.completed') {
                projection.status = 'completed';
                projection.result = record.result !== null && typeof record.result === 'object' && !Array.isArray(record.result)
                    ? record.result
                    : {};
            }
            else if (record.type === 'subagent.failed') {
                projection.status = 'failed';
                projection.error = typeof record.error === 'string' ? record.error : 'unknown failure';
            }
            else {
                return null;
            }
        }
        return projection;
    }
    catch {
        return null;
    }
}
export { ROOT as SUBAGENT_JOURNAL_ROOT };
