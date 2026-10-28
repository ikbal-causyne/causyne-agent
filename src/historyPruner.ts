import { spillToolResult, buildDecayPointer } from './outputStore.js';

export interface ToolObservation {
  role: string;
  name?: string;
  content: unknown;
  spillPath?: string;
  tool_call_id?: string;
}

export interface ObservationPruneResult {
  pruned: number;
  reclaimedChars: number;
  spillFailures: number;
}

/**
 * Shorten a single oversized observation only after preserving the complete
 * result. Recent observations need this path too: the last-four policy does
 * not make a 60 KB result safe to resend in full on every model call.
 */
export function shortenOversizedToolObservations(
  messages: ToolObservation[],
  options: { threshold?: number; taskId?: string } = {}
): ObservationPruneResult {
  const threshold = Math.max(1, options.threshold ?? 2500);
  let pruned = 0;
  let reclaimedChars = 0;
  let spillFailures = 0;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message || message.role !== 'tool' || typeof message.content !== 'string') continue;
    const original = message.content;
    if (original.length <= threshold || original.startsWith(MARKER)) continue;
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
    if (shortened.length >= original.length) continue;
    message.content = shortened;
    if (spillPath) message.spillPath = spillPath;
    pruned++;
    reclaimedChars += original.length - shortened.length;
  }
  return { pruned, reclaimedChars, spillFailures };
}

/** Keep a small recovery index when old messages leave the active window. */
export function buildRecoverableDroppedSummary(
  dropped: ToolObservation[],
  baseSummary: string,
  maxPointers = 8
): string {
  const paths = new Map<string, string>();
  for (const message of dropped) {
    // A later compaction may remove an earlier compaction summary. Carry its
    // recovery index forward so repeated compaction does not orphan files.
    if (message.role === 'user' && typeof message.content === 'string'
      && message.content.startsWith('[COMPACTED CONTEXT SUMMARY — ')) {
      for (const line of message.content.split('\n')) {
        const prior = /^([^\n]+ \((?:reported success|reported failure|outcome unverified)\): (\/[^\n]+))$/.exec(line);
        if (prior?.[2]) paths.set(prior[2], line);
      }
    }
    if (message.role !== 'tool' || !message.spillPath) continue;
    const verdict = typeof message.content === 'string' && message.content.startsWith(MARKER)
      ? (/^\[decayed\] [^:]+: (reported success|reported failure|outcome unverified)/.exec(message.content)?.[1]
        ?? 'outcome unverified')
      : typeof message.content === 'string' ? verdictFor(message.content) : 'outcome unverified';
    paths.set(message.spillPath, `${message.name ?? 'tool'} (${verdict}): ${message.spillPath}`);
  }
  if (paths.size === 0) return baseSummary;
  const recent = [...paths.values()].slice(-Math.max(0, maxPointers));
  const omitted = paths.size - recent.length;
  const index = `Recoverable prior tool output (${paths.size} saved; local files expire after retention):\n`
    + recent.join('\n')
    + (omitted > 0 ? `\n${omitted} older saved outputs omitted from this summary.` : '');
  return baseSummary ? `${baseSummary}\n${index}` : index;
}

const MARKER = '[decayed]';

function verdictFor(content: string): string {
  try {
    const value: unknown = JSON.parse(content);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (record.success === true) return 'reported success';
      if (record.success === false) return 'reported failure';
    }
  } catch {
    // Plain text and provider-specific results have no machine-verifiable verdict.
  }
  return 'outcome unverified';
}

/**
 * Preserve recent observations verbatim. Older large observations are replaced
 * only after the complete text is saved to the private output store. The
 * assistant/tool call pairing and IDs are left untouched.
 */
export function pruneStaleToolObservations(
  messages: ToolObservation[],
  options: { keepRecent?: number; minChars?: number; taskId?: string } = {}
): ObservationPruneResult {
  const keepRecent = Math.max(0, options.keepRecent ?? 4);
  const minChars = Math.max(1, options.minChars ?? 600);
  let seen = 0;
  let pruned = 0;
  let reclaimedChars = 0;
  let spillFailures = 0;

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || message.role !== 'tool') continue;
    seen++;
    if (seen <= keepRecent || typeof message.content !== 'string') continue;
    const original = message.content;
    if (original.length < minChars || original.startsWith(MARKER)) continue;

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
    if (summary.length >= original.length) continue;

    message.content = summary;
    if (spillPath) message.spillPath = spillPath;
    pruned++;
    reclaimedChars += original.length - summary.length;
  }

  return { pruned, reclaimedChars, spillFailures };
}
