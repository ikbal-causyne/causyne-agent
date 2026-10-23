// Continuum Context Compactor: protects token budgets and preserves Root Anchor Intent.
// Authorship: Strict TypeScript (Causyne Agent).
/**
 * Compact a long multi-turn peer conversation into an optimal context window
 * without losing root intention or recent critical decisions.
 */
export function compactContinuumMessages(messages, options = {}) {
    const maxTurns = options.maxTurns ?? 30;
    const recentTurns = options.recentTurns ?? 12;
    if (messages.length <= maxTurns) {
        return prefixHandshake(messages, options);
    }
    // Find root anchor (first user message)
    const rootIndex = messages.findIndex(m => m.role === 'user');
    const rootMessage = rootIndex !== -1
        ? messages[rootIndex]
        : { role: 'user', content: 'Initial user turn' };
    const recentStart = messages.length - recentTurns;
    const recent = messages.slice(recentStart);
    // If the root intent is already within the recent window, simply return recent
    if (rootIndex !== -1 && rootIndex >= recentStart) {
        return prefixHandshake(recent, options);
    }
    // Summarize middle turns between root and recent
    const middleStart = rootIndex !== -1 ? rootIndex + 1 : 0;
    const middleEnd = recentStart;
    const middleCount = Math.max(0, middleEnd - middleStart);
    const middleSummaryText = `[Continuum Context Condensation]\n` +
        `Preserved initial root intent and the last ${recent.length} active turns.\n` +
        `${middleCount} intermediate turns were compressed. ` +
        `Original agent: ${options.platform || 'peer agent'}, topic: "${options.sourceTitle || 'Untitled'}".`;
    const condensedMiddle = {
        role: 'system',
        content: middleSummaryText
    };
    const compacted = [
        rootMessage,
        condensedMiddle,
        ...recent
    ];
    return prefixHandshake(compacted, options);
}
function prefixHandshake(messages, options) {
    const platformLabel = options.platform ? options.platform.toUpperCase() : 'PEER AGENT';
    const header = `[Continuum Handshake · Adopted from ${platformLabel}]\n` +
        `Session: "${options.sourceTitle || 'Untitled'}"\n` +
        `Original workspace: ${options.originalWorkspace || '(unspecified)'}\n` +
        `Status: Adopted into Causyne Agent foreground session. Seamlessly continue the user's objective.`;
    const anchorMessage = {
        role: 'system',
        content: header
    };
    return [anchorMessage, ...messages];
}
