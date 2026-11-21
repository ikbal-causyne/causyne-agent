import { createHash } from 'node:crypto';
import { normalizeToolName, normalizeUniversalSchema } from '../tools/toolScanner.js';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
/** Preserve constraints and nested schemas while compiling union/combinator edge cases safely. */
export function normalizeToolContracts(tools) {
    if (!Array.isArray(tools))
        return [];
    const byName = new Map();
    for (const raw of tools) {
        const tool = object(raw);
        const fn = object(tool.function);
        const rawName = typeof tool.name === 'string' ? tool.name : (typeof fn.name === 'string' ? fn.name : '');
        const name = rawName.trim() ? normalizeToolName(rawName.trim()) : '';
        if (!name)
            continue;
        const rawDesc = typeof tool.description === 'string' ? tool.description : (typeof fn.description === 'string' ? fn.description : '');
        const rawParams = object(tool.parameters || tool.input_schema || fn.parameters);
        const cleanParams = Object.keys(rawParams).length > 0
            ? object(normalizeUniversalSchema(rawParams, [], [], 'strict_json'))
            : rawParams;
        byName.set(name, {
            name,
            description: rawDesc,
            parameters: cleanParams
        });
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export function contractFingerprint(value) {
    const stable = (item) => Array.isArray(item) ? item.map(stable)
        : item !== null && typeof item === 'object'
            ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, stable(val)]))
            : item;
    return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
export function formatToolContracts(tools) {
    return normalizeToolContracts(tools).map(tool => JSON.stringify(tool)).join('\n');
}
/** Current allowlist plus only changed contracts, for peers retaining their own history. */
export function toolContractUpdate(tools, previous) {
    const current = normalizeToolContracts(tools);
    const before = new Map(normalizeToolContracts(previous).map(tool => [tool.name, contractFingerprint(tool)]));
    if (contractFingerprint(current) === contractFingerprint(normalizeToolContracts(previous)))
        return '';
    const changed = current.filter(tool => before.get(tool.name) !== contractFingerprint(tool));
    return '[Current Causyne tools — replaces the prior host allowlist only; peer-native tools remain available]\n'
        + JSON.stringify(current.map(tool => tool.name))
        + '\nUse retained schemas for unchanged tools. New or changed contracts (JSON Schema):\n'
        + changed.map(tool => JSON.stringify(tool)).join('\n');
}
