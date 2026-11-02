/**
 * @file src/memory/contextBudget.ts
 * Measured Iterative Context Budgeting for Causyne Episodic Memory.
 *
 * Instead of guessing fixed item counts or slicing strings mid-line, `fitEpisodicContextToBudget`
 * renders the context and iteratively drops the most expensive components in a deterministic
 * loss order until the output fits within `maxChars`:
 *   1. Drop expanded observation narratives (keep compact index lines)
 *   2. Drop full prior-session summary narratives (keep request/completed headline)
 *   3. Drop prior session's trailing note
 *   4. Halve session summary count until 0
 *   5. Halve observation count until 1
 *
 * Guarantees valid, well-formed Markdown where headers and core timeline rows survive.
 *
 * Authorship: Strict TypeScript (Causyne Agent).
 */
export const DEFAULT_EPISODIC_BUDGET_CHARS = 3600;
const MAX_REDUCTION_ITERATIONS = 16;
function formatShortTime(epochMs) {
    try {
        const d = new Date(epochMs);
        const yyyy = d.getUTCFullYear();
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(d.getUTCDate()).padStart(2, '0');
        const hh = String(d.getUTCHours()).padStart(2, '0');
        const min = String(d.getUTCMinutes()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
    }
    catch {
        return 'recent';
    }
}
/**
 * Render the episodic context block for a given state configuration.
 */
export function renderEpisodicContext(input) {
    if (input.observations.length === 0 && input.summaries.length === 0 && !input.priorTrailingNote) {
        return '';
    }
    const lines = [
        `# EPISODIC WORKSPACE MEMORY (${input.project || 'workspace'}) — ACT-R Ranked`,
        'Use `memory_recall` (`search` -> `timeline` -> `get`) to inspect full historical details on demand.'
    ];
    if (input.observations.length > 0) {
        lines.push('## Key Workspace Observations');
        for (const obs of input.observations) {
            const rBadge = obs.reinforcementCount > 0 ? ` [x${obs.reinforcementCount + 1}]` : '';
            const files = obs.filesModified.length > 0
                ? ` (${obs.filesModified.slice(0, 2).join(', ')})`
                : obs.filesRead.length > 0
                    ? ` (${obs.filesRead.slice(0, 1).join(', ')})`
                    : '';
            lines.push(`- #${obs.id} [${obs.type}]${rBadge} ${obs.title}${files} (${formatShortTime(obs.createdAtEpochMs)})`);
            if (input.fullObservationIds?.has(obs.id) && obs.narrative) {
                lines.push(`  Narrative: ${obs.narrative.slice(0, 280)}`);
                if (obs.facts.length > 0) {
                    lines.push(`  Facts: ${obs.facts.slice(0, 3).join('; ')}`);
                }
            }
        }
    }
    if (input.summaries.length > 0) {
        lines.push('## Recent Session Checkpoints');
        for (let i = 0; i < input.summaries.length; i++) {
            const s = input.summaries[i];
            if (!s)
                continue;
            lines.push(`- S#${s.id}: ${s.request.slice(0, 120)} -> ${s.completed.slice(0, 140)}`);
            if (i === 0 && input.showLastSummaryDetails) {
                if (s.learned)
                    lines.push(`  Learned: ${s.learned.slice(0, 200)}`);
                if (s.nextSteps)
                    lines.push(`  Next: ${s.nextSteps.slice(0, 160)}`);
            }
        }
    }
    if (input.priorTrailingNote) {
        lines.push(`## Prior Context Note\n${input.priorTrailingNote.slice(0, 240)}`);
    }
    return lines.join('\n');
}
function reduceStateOnce(state) {
    // Stage 1: Drop full observation narratives (keep compact timeline titles)
    if (state.fullObservationIds && state.fullObservationIds.size > 0) {
        return { ...state, fullObservationIds: new Set() };
    }
    // Stage 2: Drop full last-session summary details
    if (state.showLastSummaryDetails) {
        return { ...state, showLastSummaryDetails: false };
    }
    // Stage 3: Drop prior trailing note
    if (state.priorTrailingNote !== undefined) {
        return { ...state, priorTrailingNote: undefined };
    }
    // Stage 4: Halve session summaries down to 0
    if (state.summaries.length > 0) {
        const nextCount = Math.floor(state.summaries.length / 2);
        return { ...state, summaries: state.summaries.slice(0, nextCount) };
    }
    // Stage 5: Halve observations down to 1
    if (state.observations.length > 1) {
        const nextCount = Math.max(1, Math.floor(state.observations.length / 2));
        return { ...state, observations: state.observations.slice(0, nextCount) };
    }
    return null;
}
/**
 * Iteratively reduce `input` until `renderEpisodicContext(state).length <= maxChars`,
 * or until the floor (1 compact observation title, 0 summaries) is reached.
 */
export function fitEpisodicContextToBudget(input, maxChars = DEFAULT_EPISODIC_BUDGET_CHARS) {
    if (maxChars <= 0)
        return '';
    let state = {
        ...input,
        fullObservationIds: input.fullObservationIds ? new Set(input.fullObservationIds) : new Set(),
        showLastSummaryDetails: input.showLastSummaryDetails ?? true
    };
    let rendered = renderEpisodicContext(state);
    let iterations = 0;
    while (rendered.length > maxChars && iterations < MAX_REDUCTION_ITERATIONS) {
        const next = reduceStateOnce(state);
        if (!next)
            break;
        state = next;
        rendered = renderEpisodicContext(state);
        iterations += 1;
    }
    return rendered;
}
