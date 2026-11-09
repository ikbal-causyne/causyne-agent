function compactMessage(value) {
    if (typeof value === 'string')
        return value.slice(0, 4096);
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
        return String(value);
    if (value === null || value === undefined)
        return 'Unknown provider error';
    try {
        const text = String(value);
        return text.length > 4096 ? `${text.slice(0, 4096)}…` : text;
    }
    catch {
        return 'Provider threw a value that could not be stringified';
    }
}
export function normalizeAgentFailure(value) {
    if (value instanceof Error)
        return value;
    const candidate = value && typeof value === 'object'
        ? value : {};
    const sourceMessage = typeof candidate.message === 'string' ? candidate.message : value;
    const error = new Error(compactMessage(sourceMessage));
    for (const field of ['code', 'partialUsage', 'status', 'reason']) {
        if (Object.hasOwn(candidate, field))
            error[field] = candidate[field];
    }
    if (typeof candidate.name === 'string')
        error.name = candidate.name;
    return error;
}
