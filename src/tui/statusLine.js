// The line that tells the user what is happening to their money and their time.
//
// While a turn ran, the chat printed one thing:
//
//   ⠋ Thinking…
//
// and that was the entire signal for what could be a four-minute, forty-step,
// several-dollar run. The user could not see elapsed time, which model was
// spending, how many steps had gone by, how many tokens the turn had burned, or
// what was left. All of those numbers were already in memory — the loop broadcasts
// `usage_update` on every response and the config carries the model — and none of
// it was shown.
//
// The line degrades by DROPPING SEGMENTS, right to left, until it fits. A narrow
// terminal loses the cost before it loses the elapsed time, and loses the
// elapsed time before it loses the message. It never wraps, because a wrapping
// spinner leaves debris every tick.
//
// Pure TypeScript over ./theme.js and ./text.js. No dependency, no shell.
// @ts-expect-error theme.js has no TypeScript declaration yet.
import { paint, dim, GLYPHS } from './theme.js';
import { truncate, visibleWidth, safeDisplay, shortenHome } from './text.js';
import { contextMeter } from './block.js';
import { CHARS_PER_TOKEN } from '../contextManager.js';
import { formatAnimatedStatus } from './engineSpinner.js';
/** 1234 -> "1.2k", 1234567 -> "1.2M". Token counts are read, not summed. */
export function compactCount(value) {
    const n = Number(value) || 0;
    if (n < 1000)
        return String(Math.round(n));
    if (n < 1000000)
        return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
    return `${(n / 1000000).toFixed(1)}M`;
}
/**
 * Money, at the precision the number deserves.
 *
 * Sub-cent runs printed as "$0.00" read as free, which is how a user learns not
 * to look at the cost at all.
 */
export function formatCost(value) {
    const n = Number(value) || 0;
    if (n <= 0)
        return '$0';
    if (n < 0.01)
        return `$${n.toFixed(4)}`;
    if (n < 1)
        return `$${n.toFixed(3)}`;
    return `$${n.toFixed(2)}`;
}
export function formatElapsed(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    if (total < 60)
        return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    if (minutes < 60)
        return `${minutes}m${String(seconds).padStart(2, '0')}s`;
    return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}
/** Strip a provider prefix so "anthropic/claude-opus-5" reads as the model. */
function shortModel(model) {
    const name = String(model || '').split('/').pop() || '';
    return name.length > 22 ? name.slice(0, 21) + GLYPHS.ellipsis : name;
}
export class StatusLine {
    model = '';
    provider = '';
    tier = '';
    cwd = '';
    // Both in CHARACTERS — the unit the window is actually budgeted in.
    contextLimit = 0;
    contextChars = 0;
    turnTokens = 0;
    turnCost = 0;
    cachedTokens = 0;
    constructor() {
        this.reset();
    }
    /** Session-lifetime facts, set once from the same info as the header. */
    setSession(info = {}) {
        if (info.model !== undefined)
            this.model = shortModel(info.model);
        if (info.provider !== undefined)
            this.provider = info.provider ? String(info.provider) : '';
        if (info.tier !== undefined)
            this.tier = info.tier ? String(info.tier) : '';
        if (info.cwd !== undefined)
            this.cwd = info.cwd ? String(info.cwd) : '';
        if (Number(info.contextLimit) > 0)
            this.contextLimit = Number(info.contextLimit);
        if (Number(info.contextChars) > 0)
            this.contextChars = Number(info.contextChars);
        return this;
    }
    /** Per-turn counters. */
    reset() {
        this.turnTokens = 0;
        this.turnCost = 0;
        this.cachedTokens = 0;
        // Note: Do NOT reset this.contextChars to 0 here. Context window usage
        // belongs to the whole conversation, not just a single active turn.
        return this;
    }
    /**
     * The idle footer: where you are, and how much context is left.
     */
    renderIdle({ width = 80, hint = '' } = {}) {
        const budget = Math.max(10, width - 1);
        const meter = contextMeter(Math.round(this.contextChars / CHARS_PER_TOKEN), Math.round(this.contextLimit / CHARS_PER_TOKEN));
        const segments = [];
        if (meter)
            segments.push(meter);
        if (hint)
            segments.push(hint);
        const separator = `  ${GLYPHS.dot}  `;
        const kept = segments.slice();
        let tail = kept.join(separator);
        while (kept.length > 1 && visibleWidth(tail) > Math.floor(budget / 2)) {
            kept.pop();
            tail = kept.join(separator);
        }
        if (visibleWidth(tail) > budget)
            tail = '';
        const room = tail ? Math.max(0, budget - visibleWidth(tail) - visibleWidth(separator)) : budget;
        const where = this.cwd ? truncate(shortenHome(this.cwd), room, GLYPHS.ellipsis) : '';
        const left = dim(where);
        if (!tail)
            return left;
        const gap = Math.max(visibleWidth(separator), width - 1 - visibleWidth(left) - visibleWidth(tail));
        return `${left}${' '.repeat(gap)}${dim(tail)}`;
    }
    /**
     * Consume a `usage_update` frame.
     */
    onUsage(msg = {}) {
        this.turnTokens = Number(msg.taskTokens) || Number(msg.usedTokens) || this.turnTokens;
        if (Number(msg.contextChars) > 0)
            this.contextChars = Number(msg.contextChars);
        if (Number(msg.contextLimitChars) > 0)
            this.contextLimit = Number(msg.contextLimitChars);
        const responseCost = Number(msg.costUsd) || 0;
        const taskCost = Number(msg.taskCostUsd) || 0;
        this.turnCost = taskCost > 0 ? taskCost : this.turnCost + responseCost;
        this.cachedTokens = Number(msg.cachedTokens) || 0;
        return this;
    }
    /**
     * Build the line.
     */
    render({ message = '', elapsedMs = 0, steps = 0, width = 80, spinnerFrame = '', tick } = {}) {
        const head = spinnerFrame
            ? (typeof spinnerFrame === 'string' && spinnerFrame.includes('\x1b')
                ? `${spinnerFrame} `
                : `${paint('accent', spinnerFrame)} `)
            : '';
        const budget = Math.max(10, width - visibleWidth(head) - 1);
        const segments = [];
        if (elapsedMs > 0)
            segments.push(formatElapsed(elapsedMs));
        if (steps > 0)
            segments.push(`step ${steps}`);
        if (this.turnTokens > 0)
            segments.push(`${compactCount(this.turnTokens)} tok`);
        if (this.turnCost > 0)
            segments.push(formatCost(this.turnCost));
        if (this.cachedTokens > 0)
            segments.push(`${compactCount(this.cachedTokens)} cached`);
        if (this.model)
            segments.push(this.model);
        const separator = `  ${GLYPHS.dot}  `;
        const rawMessage = tick !== undefined
            ? formatAnimatedStatus(message || 'working', tick)
            : (message || (spinnerFrame ? 'working' : ''));
        const text = safeDisplay(rawMessage);
        const kept = segments.slice();
        const wanted = Math.min(visibleWidth(text), Math.max(18, Math.floor(budget / 2)));
        while (kept.length > 0) {
            const tail = kept.join(separator);
            if (visibleWidth(tail) + separator.length + wanted <= budget)
                break;
            kept.pop();
        }
        const tail = kept.length > 0 ? kept.join(separator) : '';
        const messageBudget = tail
            ? Math.max(1, budget - visibleWidth(tail) - separator.length)
            : budget;
        const body = truncate(text, messageBudget, GLYPHS.ellipsis);
        const left = `${head}${paint('muted', body)}`;
        if (!tail)
            return left;
        const gap = Math.max(visibleWidth(separator), width - 1 - visibleWidth(left) - visibleWidth(tail));
        return `${left}${' '.repeat(gap)}${dim(tail)}`;
    }
    /**
     * The non-TTY form: no spinner, no elapsed clock, printed once.
     */
    renderStatic(message, width = 80) {
        const parts = [safeDisplay(message)];
        if (this.model)
            parts.push(this.model);
        return truncate(`${GLYPHS.dot} ${parts.join(`  ${GLYPHS.dot}  `)}`, width, GLYPHS.ellipsis);
    }
}
