import { spillToolResult, buildDecayPointer } from './outputStore.js';
import { processToolOutputWithStore, renderSpillDocument } from './tools/toolOutputStore.js';
/** Archive large arguments only after a matching tool observation exists. */
export function pruneExecutedToolArguments(messages, options = {}) {
    const completed = new Set(messages.filter(message => message.role === 'tool').map(message => message.tool_call_id));
    const recoveryPaths = [];
    let pruned = 0, reclaimedChars = 0, spillFailures = 0;
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (message?.role !== 'assistant')
            continue;
        for (const call of message.tool_calls || []) {
            const original = call.function?.arguments;
            if (typeof original !== 'string' || !call.id || !completed.has(call.id))
                continue;
            let args;
            try {
                const parsed = JSON.parse(original);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                    continue;
                args = parsed;
            }
            catch {
                continue;
            }
            if (typeof args._causyne_archived_args === 'string') {
                recoveryPaths.push(args._causyne_archived_args);
                continue;
            }
            if (original.length <= (options.threshold ?? 2500))
                continue;
            const stored = processToolOutputWithStore(options.taskId ?? 'history', `arguments-${call.id}`, renderSpillDocument(args, { taskId: options.taskId ?? 'history', step: index, tool: call.function?.name ?? 'tool' }));
            if (!stored.diskPath) {
                spillFailures++;
                continue;
            }
            const compact = {
                _causyne_archived_args: stored.diskPath,
                note: 'Historical executed call; complete parameters are archived. Do not replay this placeholder. Read the current target file or archived parameters if needed.'
            };
            for (const key of ['path', 'file_path', 'target', 'action']) {
                if (typeof args[key] === 'string' && args[key].length <= 500)
                    compact[key] = args[key];
            }
            const replacement = JSON.stringify(compact);
            if (replacement.length >= original.length || !call.function)
                continue;
            call.function.arguments = replacement;
            recoveryPaths.push(stored.diskPath);
            pruned++;
            reclaimedChars += original.length - replacement.length;
        }
    }
    return { pruned, reclaimedChars, spillFailures, recoveryPaths };
}
/**
 * Shorten a single oversized observation only after preserving the complete
 * result. Recent observations need this path too: the last-four policy does
 * not make a 60 KB result safe to resend in full on every model call.
 */
export function shortenOversizedToolObservations(messages, options = {}) {
    const threshold = Math.max(1, options.threshold ?? 2500);
    let pruned = 0;
    let reclaimedChars = 0;
    let spillFailures = 0;
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (!message || message.role !== 'tool' || typeof message.content !== 'string')
            continue;
        const original = message.content;
        if (original.length <= threshold || original.startsWith(MARKER))
            continue;
        let spillPath = message.spillPath;
        if (!spillPath) {
            const spill = spillToolResult(original, {
                taskId: options.taskId ?? 'history', step: index, tool: message.name ?? 'tool'
            });
            if (!spill || typeof spill.path !== 'string') {
                spillFailures++;
                continue;
            }
            spillPath = spill.path;
        }
        const headLen = Math.min(3000, Math.max(200, Math.floor(threshold * 0.45)));
        const tailLen = Math.min(1500, Math.max(200, Math.floor(threshold * 0.35)));
        const head = original.slice(0, headLen);
        const tail = original.slice(-tailLen);
        const omitted = original.length - head.length - tail.length;
        const shortened = `${head}\n[${omitted} middle characters omitted from active context. Full output saved${buildDecayPointer({ path: spillPath })}]\n${tail}`;
        if (shortened.length >= original.length)
            continue;
        message.content = shortened;
        if (spillPath)
            message.spillPath = spillPath;
        pruned++;
        reclaimedChars += original.length - shortened.length;
    }
    return { pruned, reclaimedChars, spillFailures };
}
/** Keep a small recovery index when old messages leave the active window. */
export function buildRecoverableDroppedSummary(dropped, baseSummary, maxPointers = 8) {
    const paths = new Map();
    for (const message of dropped) {
        for (const call of message.role === 'assistant' ? message.tool_calls ?? [] : []) {
            try {
                const args = typeof call.function?.arguments === 'string' ? JSON.parse(call.function.arguments) : null;
                if (args && typeof args === 'object' && '_causyne_archived_args' in args
                    && typeof args._causyne_archived_args === 'string') {
                    paths.set(args._causyne_archived_args, `${call.function?.name ?? 'tool'} arguments (outcome unverified): ${args._causyne_archived_args}`);
                }
            }
            catch { /* Unarchived or malformed historical arguments have no recovery pointer. */ }
        }
        // A later compaction may remove an earlier compaction summary. Carry its
        // recovery index forward so repeated compaction does not orphan files.
        if (message.role === 'user' && typeof message.content === 'string'
            && message.content.startsWith('[COMPACTED CONTEXT SUMMARY — ')) {
            for (const line of message.content.split('\n')) {
                const prior = /^([^\n]+ \((?:reported success|reported failure|outcome unverified)\): (\/[^\n]+))$/.exec(line);
                if (prior?.[2])
                    paths.set(prior[2], line);
            }
        }
        if (message.role !== 'tool' || !message.spillPath)
            continue;
        const verdict = typeof message.content === 'string' && message.content.startsWith(MARKER)
            ? (/^\[decayed\] [^:]+: (reported success|reported failure|outcome unverified)/.exec(message.content)?.[1]
                ?? 'outcome unverified')
            : typeof message.content === 'string' ? verdictFor(message.content) : 'outcome unverified';
        paths.set(message.spillPath, `${message.name ?? 'tool'} (${verdict}): ${message.spillPath}`);
    }
    if (paths.size === 0)
        return baseSummary;
    const recent = [...paths.values()].slice(-Math.max(0, maxPointers));
    const omitted = paths.size - recent.length;
    const index = `Recoverable prior tool output (${paths.size} saved; local files expire after retention):\n`
        + recent.join('\n')
        + (omitted > 0 ? `\n${omitted} older saved outputs omitted from this summary.` : '');
    return baseSummary ? `${baseSummary}\n${index}` : index;
}
const MARKER = '[decayed]';
function verdictFor(content) {
    try {
        const value = JSON.parse(content);
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            const record = value;
            if (record.success === true)
                return 'reported success';
            if (record.success === false)
                return 'reported failure';
        }
    }
    catch {
        // Plain text and provider-specific results have no machine-verifiable verdict.
    }
    return 'outcome unverified';
}
/**
 * Preserve recent observations verbatim. Older large observations are replaced
 * only after the complete text is saved to the private output store. The
 * assistant/tool call pairing and IDs are left untouched.
 */
export function pruneStaleToolObservations(messages, options = {}) {
    const keepRecent = Math.max(0, options.keepRecent ?? 4);
    const minChars = Math.max(1, options.minChars ?? 600);
    let seen = 0;
    let pruned = 0;
    let reclaimedChars = 0;
    let spillFailures = 0;
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (!message || message.role !== 'tool')
            continue;
        seen++;
        if (seen <= keepRecent || typeof message.content !== 'string')
            continue;
        const original = message.content;
        if (original.length < minChars || original.startsWith(MARKER))
            continue;
        let spillPath = message.spillPath;
        if (!spillPath) {
            const spill = spillToolResult(original, {
                taskId: options.taskId ?? 'history',
                step: index,
                tool: message.name ?? 'tool'
            });
            if (!spill || typeof spill.path !== 'string') {
                spillFailures++;
                continue;
            }
            spillPath = spill.path;
        }
        const summary = `${MARKER} ${message.name ?? 'tool'}: ${verdictFor(original)}. `
            + `Earlier output (${original.length} characters) was cleared from context.`
            + buildDecayPointer({ path: spillPath });
        if (summary.length >= original.length)
            continue;
        message.content = summary;
        if (spillPath)
            message.spillPath = spillPath;
        pruned++;
        reclaimedChars += original.length - summary.length;
    }
    return { pruned, reclaimedChars, spillFailures };
}
