// The line that tells the user what is happening to their money and their time.
//
// While a turn ran, the chat printed one thing:
//
//   ⠋ Thinking…
//
// and that was the entire signal for what could be a four-minute, forty-step,
// several-dollar run. The user could not see elapsed time, which model was
// spending, how many steps had gone by, how many tokens the turn had burned, or

// those numbers was already in memory — the loop broadcasts `usage_update` on
// every response and the config carries the model — and none of it was shown.
//
// openclaw puts elapsed and connection state on its waiting line; opencode keeps
// a permanent footer with cwd, LSP and MCP counts. This is the same idea in
// Causyne's register: no whimsy, just the four numbers a person needs to decide
// whether to let a run continue or press esc.
//
// The line degrades by DROPPING SEGMENTS, right to left, until it fits. A narrow
// terminal loses the cost before it loses the elapsed time, and loses the
// elapsed time before it loses the message. It never wraps, because a wrapping
// spinner leaves debris every tick.
//
// Pure Node over ./theme.js and ./text.js. No dependency, no shell.

import { paint, dim, GLYPHS } from './theme.js';
import { truncate, visibleWidth, safeDisplay, shortenHome } from './text.js';
import { contextMeter } from './block.js';
import { CHARS_PER_TOKEN } from '../contextManager.js';

/** 1234 -> "1.2k", 1234567 -> "1.2M". Token counts are read, not summed. */
export function compactCount(value) {
  const n = Number(value) || 0;
  if (n < 1000) return String(Math.round(n));
  if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
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
  if (n <= 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export function formatElapsed(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

/** Strip a provider prefix so "anthropic/claude-opus-5" reads as the model. */
function shortModel(model) {
  const name = String(model || '').split('/').pop() || '';
  return name.length > 22 ? name.slice(0, 21) + GLYPHS.ellipsis : name;
}

export class StatusLine {
  constructor() {
    this.model = '';
    this.provider = '';
    this.tier = '';
    this.cwd = '';
    // Both in CHARACTERS — the unit the window is actually budgeted in.
    // `contextLimit` always was; the numerator was the thing that was wrong.
    this.contextLimit = 0;
    this.contextChars = 0;
    this.reset();
  }

  /** Session-lifetime facts, set once from the same info as the header. */
  setSession(info = {}) {
    this.model = shortModel(info.model);
    this.provider = info.provider ? String(info.provider) : '';
    this.tier = info.tier ? String(info.tier) : '';
    // The idle footer answers "where am I and how much room is left", which is
    // what opencode's permanent footer shows (cwd left, context right). Neither
    // fact was reachable once the session header had scrolled away.
    this.cwd = info.cwd ? String(info.cwd) : '';
    this.contextLimit = Number(info.contextLimit) || 0;
    return this;
  }

  /** Per-turn counters. */
  reset() {
    this.turnTokens = 0;
    this.turnCost = 0;
    this.cachedTokens = 0;
    this.contextChars = 0;
    return this;
  }

  /**
   * The idle footer: where you are, and how much context is left.
   *
   * A separate shape from the working line on purpose. While a turn runs the
   * user is deciding whether to let it continue, so the line carries elapsed,
   * steps, tokens and cost. Between turns none of those are actionable, and the
   * two facts that are — the working directory and the remaining context — had
   * nowhere to live. Same justification as render(): left fact, right numbers.
   */
  renderIdle({ width = 80, hint = '' } = {}) {
    const budget = Math.max(10, width - 1);
    // Characters in, characters out — then one conversion, so both halves of
    // "24K (20%)" describe the same measurement. Feeding this the task's
    // CUMULATIVE token spend and dividing by a character pool is what produced
    // a permanent "290K (99%)" on a window that was nowhere near full.
    const meter = contextMeter(
      Math.round(this.contextChars / CHARS_PER_TOKEN),
      Math.round(this.contextLimit / CHARS_PER_TOKEN)
    );
    const segments = [];
    if (meter) segments.push(meter);
    if (hint) segments.push(hint);

    const separator = `  ${GLYPHS.dot}  `;
    let kept = segments.slice();
    let tail = kept.join(separator);
    // Drop the hint before the number: a truncated keybinding is a wrong one.
    while (kept.length > 1 && visibleWidth(tail) > Math.floor(budget / 2)) {
      kept.pop();
      tail = kept.join(separator);
    }
    if (visibleWidth(tail) > budget) tail = '';

    const room = tail ? Math.max(0, budget - visibleWidth(tail) - visibleWidth(separator)) : budget;
    const where = this.cwd ? truncate(shortenHome(this.cwd), room, GLYPHS.ellipsis) : '';
    const left = dim(where);
    if (!tail) return left;

    const gap = Math.max(
      visibleWidth(separator),
      width - 1 - visibleWidth(left) - visibleWidth(tail)
    );
    return `${left}${' '.repeat(gap)}${dim(tail)}`;
  }

  /**
   * Consume a `usage_update` frame.
   *
   * taskCostUsd is the whole task; costUsd is this response. The turn total is
   * what the user is deciding about right now, so accumulate that.
   */
  onUsage(msg = {}) {
    // TASK scope, explicitly. `usedTokens` now carries the DAILY total, which is
    
    // shows — the working line is about the turn the user is deciding on.
    this.turnTokens = Number(msg.taskTokens) || Number(msg.usedTokens) || this.turnTokens;
    // What the request actually carried, measured at the point it was built.
    if (Number(msg.contextChars) > 0) this.contextChars = Number(msg.contextChars);
    if (Number(msg.contextLimitChars) > 0) this.contextLimit = Number(msg.contextLimitChars);
    const responseCost = Number(msg.costUsd) || 0;
    const taskCost = Number(msg.taskCostUsd) || 0;
    // Prefer the task total when the provider reports one — it already includes
    // every response, and summing on top would double-count.
    this.turnCost = taskCost > 0 ? taskCost : this.turnCost + responseCost;
    this.cachedTokens = Number(msg.cachedTokens) || 0;
    return this;
  }

  /**
   * Build the line.
   *
   * `segments` are ordered most to least important. Anything that does not fit
   * is dropped whole — never truncated into a misleading half-number.
   */
  render({ message = '', elapsedMs = 0, steps = 0, width = 80, spinnerFrame = '' } = {}) {
    const head = spinnerFrame ? `${paint('accent', spinnerFrame)} ` : '';
    const budget = Math.max(10, width - visibleWidth(head) - 1);

    const segments = [];
    if (elapsedMs > 0) segments.push(formatElapsed(elapsedMs));
    if (steps > 0) segments.push(`step ${steps}`);
    if (this.turnTokens > 0) segments.push(`${compactCount(this.turnTokens)} tok`);
    if (this.turnCost > 0) segments.push(formatCost(this.turnCost));
    if (this.cachedTokens > 0) segments.push(`${compactCount(this.cachedTokens)} cached`);
    if (this.model) segments.push(this.model);

    const separator = `  ${GLYPHS.dot}  `;
    const text = safeDisplay(message);

    // Drop segments from the right until the message fits at its natural width.
    //
    // The message is what the user is reading; the numbers are what they glance
    // at. Reserving space for the message FIRST is what stops a wide terminal
    // from printing "reading project fi…" next to six perfectly intact counters.
    // The reservation is capped at half the line so a very long status cannot
    // squeeze every number out.
    let kept = segments.slice();
    const wanted = Math.min(visibleWidth(text), Math.max(18, Math.floor(budget / 2)));
    while (kept.length > 0) {
      const tail = kept.join(separator);
      if (visibleWidth(tail) + separator.length + wanted <= budget) break;
      kept.pop();
    }

    const tail = kept.length > 0 ? kept.join(separator) : '';
    const messageBudget = tail
      ? Math.max(1, budget - visibleWidth(tail) - separator.length)
      : budget;
    const body = truncate(text, messageBudget, GLYPHS.ellipsis);

    const left = `${head}${paint('muted', body)}`;
    if (!tail) return left;

    // Justify: message left, numbers hard right.
    //
    // Packing everything against the left edge wastes the whole right half of a
    // wide terminal and makes the counters drift horizontally as the status text
    // changes length — the eye has to re-find them every frame. Pinning them to
    // the right edge means they sit in the same column all session. This is the
    // shape opencode's session footer uses (justifyContent="space-between", the
    // directory left and the counters right).
    //
    // The fitting loop above already guarantees room for a separator between the
    // two, so the gap can never collapse to nothing.
    // Justify against width - 1, not width.
    //
    // The fitting loop above budgets `width - head - 1`, but this gap was
    // computed against the full `width`, so the finished line came back exactly
    // `width` columns — flush against the right edge, with no slack at all. A
    // terminal that renders one of the ambiguous-width glyphs in this line (`·`
    // appears twice) as two columns then wraps it, and a wrapped row in the live
    // region corrupts erase()'s row accounting. One reserved column removes the
    // whole class of failure at its source; ChatPrompt.clampRows() is the net.
    const gap = Math.max(
      visibleWidth(separator),
      width - 1 - visibleWidth(left) - visibleWidth(tail)
    );
    return `${left}${' '.repeat(gap)}${dim(tail)}`;
  }

  /**
   * The non-TTY form: no spinner, no elapsed clock, printed once.
   *
   * Piped into a CI log an animated line becomes thousands of junk rows, and an
   * elapsed time that never updates is worse than none.
   */
  renderStatic(message, width = 80) {
    const parts = [safeDisplay(message)];
    if (this.model) parts.push(this.model);
    return truncate(`${GLYPHS.dot} ${parts.join(`  ${GLYPHS.dot}  `)}`, width, GLYPHS.ellipsis);
  }
}
