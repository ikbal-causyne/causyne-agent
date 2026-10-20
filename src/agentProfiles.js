import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from './utils/paths.js';
const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/;
const MAX_PROFILES = 64;
const MAX_PROFILE_BYTES = 24 * 1024;
const MAX_INSTRUCTIONS = 16 * 1024;
const MAX_TOOLS = 64;
export function agentProfilesRoot() {
    return path.join(causyneHome(), 'agents');
}
function cleanLine(value, maximum) {
    return String(value ?? '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x7f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maximum);
}
function cleanInstructions(value) {
    return String(value ?? '')
        // Preserve newlines and tabs while excluding prompt-control bytes.
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
        .trim();
}
function boundedInteger(value, fallback, minimum, maximum) {
    if (value === undefined)
        return fallback;
    if (!Number.isInteger(value))
        return null;
    return Math.max(minimum, Math.min(Number(value), maximum));
}
function parseProfile(file, expectedName) {
    try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink())
            return { ok: false, error: 'profile must be a regular file' };
        if (stat.size > MAX_PROFILE_BYTES)
            return { ok: false, error: `profile exceeds ${MAX_PROFILE_BYTES / 1024} KB` };
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
            return { ok: false, error: 'profile must be a JSON object' };
        }
        const value = raw;
        if (value.schemaVersion !== 1)
            return { ok: false, error: 'schemaVersion must be 1' };
        if (value.name !== expectedName || !PROFILE_ID.test(expectedName)) {
            return { ok: false, error: 'profile name must match its lowercase file name' };
        }
        const description = cleanLine(value.description, 400);
        if (!description)
            return { ok: false, error: 'description is required' };
        const instructions = cleanInstructions(value.instructions);
        if (!instructions)
            return { ok: false, error: 'instructions are required' };
        if (Buffer.byteLength(instructions, 'utf8') > MAX_INSTRUCTIONS) {
            return { ok: false, error: `instructions exceed ${MAX_INSTRUCTIONS / 1024} KB` };
        }
        if (!Array.isArray(value.toolScope) || value.toolScope.length === 0 || value.toolScope.length > MAX_TOOLS) {
            return { ok: false, error: `toolScope must contain 1-${MAX_TOOLS} tool names` };
        }
        const toolScope = [];
        for (const rawTool of value.toolScope) {
            if (typeof rawTool !== 'string' || !TOOL_NAME.test(rawTool)) {
                return { ok: false, error: `invalid tool name ${JSON.stringify(rawTool)}` };
            }
            const normalized = rawTool.replace(/\./g, '_');
            if (!toolScope.includes(normalized))
                toolScope.push(normalized);
        }
        const maxSteps = boundedInteger(value.maxSteps, 25, 1, 100);
        if (maxSteps === null)
            return { ok: false, error: 'maxSteps must be an integer' };
        const maxTokens = boundedInteger(value.maxTokens, 50_000, 1_000, 200_000);
        if (maxTokens === null)
            return { ok: false, error: 'maxTokens must be an integer' };
        return {
            ok: true,
            profile: {
                schemaVersion: 1,
                name: expectedName,
                description,
                instructions,
                toolScope,
                maxSteps,
                maxTokens,
                path: file
            }
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message };
    }
}
export function loadAgentProfile(name) {
    const id = String(name ?? '');
    if (!PROFILE_ID.test(id))
        return { ok: false, error: 'invalid profile name' };
    return parseProfile(path.join(agentProfilesRoot(), `${id}.json`), id);
}
export function listAgentProfiles() {
    const profiles = [];
    const problems = [];
    const root = agentProfilesRoot();
    try {
        if (!fs.existsSync(root))
            return { profiles, problems };
        const entries = fs.readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.name.endsWith('.json') && !entry.name.startsWith('.'))
            .slice(0, MAX_PROFILES + 1);
        if (entries.length > MAX_PROFILES)
            problems.push(`only the first ${MAX_PROFILES} profiles were inspected`);
        for (const entry of entries.slice(0, MAX_PROFILES)) {
            const name = entry.name.slice(0, -5);
            if (!entry.isFile() || !PROFILE_ID.test(name)) {
                problems.push(`${entry.name}: invalid profile file`);
                continue;
            }
            const loaded = parseProfile(path.join(root, entry.name), name);
            if (loaded.ok)
                profiles.push(loaded.profile);
            else
                problems.push(`${entry.name}: ${loaded.error}`);
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        problems.push(`could not read profiles: ${message}`);
    }
    return { profiles, problems };
}
export { MAX_PROFILES, MAX_PROFILE_BYTES, MAX_INSTRUCTIONS, MAX_TOOLS };
