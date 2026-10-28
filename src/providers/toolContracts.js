import { createHash } from 'node:crypto';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
/** Preserve constraints and nested schemas; text peers need more than parameter names. */
export function normalizeToolContracts(tools) {
    return tools.map(raw => {
        const tool = object(raw);
        const fn = object(tool.function);
        return {
            name: String(tool.name || fn.name || ''),
            description: String(tool.description || fn.description || ''),
            parameters: object(tool.parameters || tool.input_schema || fn.parameters)
        };
    }).filter(tool => tool.name).sort((a, b) => a.name.localeCompare(b.name));
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
    return '[Current Causyne tools — replaces the prior allowlist]\n'
        + JSON.stringify(current.map(tool => tool.name))
        + '\nUse retained schemas for unchanged tools. New or changed contracts (JSON Schema):\n'
        + changed.map(tool => JSON.stringify(tool)).join('\n');
}
