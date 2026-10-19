// Chat transcript renderer.
//
// This replaces a 50-line if/else chain inside LocalCLIConnection.send() that
// wrote raw escape codes inline. Every frame the agent loop emits now has a
// method here, and every byte that reaches the terminal goes through the theme
// (so it degrades) and through text.safeDisplay (so untrusted tool output
// cannot move the cursor or repaint the screen).
//
// Pure JS over ./theme.js and ./text.js. No dependency, no shell.

import readline from 'readline';
import {
  paint, bold, dim, badge, GLYPHS, terminalWidth, readableWidth, HAS_COLOR, fileLink,
  safeLink, HAS_HYPERLINKS
} from './theme.js';
import {
  visibleWidth, truncate, wrap, wrapBlock, padEnd, safeDisplay, shortenHome
} from './text.js';
import { sessionBanner } from './banner.js';
import { describeTool } from './toolDisplay.js';
import { approvalDiff } from './diff.js';
import { StatusLine } from './statusLine.js';

// Bound the preview AFTER wrapping, not by source newlines: one 400 KB line of
// minified output would otherwise become thousands of rows and lock the
// terminal. (The failure openclaw's tool-execution component documents.)
const PREVIEW_LINES = 12;

// Cut the SOURCE before sanitising it, not after.
//
// safeDisplay() runs sanitize() plus four redaction passes over whatever it is
// given. Handing it a 900 KB tool result meant regex-scanning 900 KB to print
// twelve lines. openclaw's tool-execution component bounds the source first for
// exactly this reason; 256 columns per previewed line is far more than any
// terminal shows and still bounds the work at a few KB.
const PREVIEW_SOURCE_BUDGET = PREVIEW_LINES * 256;

// How much of a model's chain of thought to show inline.
//
// Reasoning models emit thousands of tokens of it. Printed in full it buries
// the answer it was reasoning towards, which is the opposite of useful — and on
// the Stage it would push the reply off the viewport entirely. The frame keeps
// the whole thing, so nothing is lost; this is only what is shown at rest.
const REASONING_LINES = 12;

// Column where the timing/status gutter starts, so tool rows line up.
const STATUS_GUTTER = 10;

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

/**
 * Minimal markdown for a terminal.
 *
 * Agent replies are markdown; printing them raw means the user reads literal
 * `**bold**` and ``` fences. This is deliberately small — headings, emphasis,
 * inline code, fenced blocks and list bullets. Anything fancier belongs in a
 * pager, not a chat transcript.
 */
function renderMarkdown(text, width) {
  const lines = [];
  let inFence = false;

  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.replace(/\s+$/, '');

    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      const language = line.replace(/^\s*```/, '').trim();
      lines.push(dim(`${GLYPHS.hLine.repeat(3)}${language ? ' ' + language + ' ' : ' '}${GLYPHS.hLine.repeat(Math.max(0, width - 6 - language.length))}`));
      continue;
    }
    if (inFence) {
      lines.push(paint('accent', '  ' + truncate(line, width - 2, '')));
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      lines.push('');
      lines.push(bold(paint('ink', heading[2])));
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      const indent = bullet[1] + '  ';
      const wrapped = wrap(inline(bullet[2]), width - indent.length - 2);
      wrapped.forEach((part, index) => {
        lines.push(index === 0 ? `${indent}${paint('muted', GLYPHS.bullet)} ${part}` : `${indent}  ${part}`);
      });
      continue;
    }

    if (line.trim() === '') { lines.push(''); continue; }
    for (const part of wrap(inline(line), width)) lines.push(part);
  }

  // A fence that never closed.
  //
  // `inFence` simply toggles, so an unbalanced ``` used to swallow every
  // remaining line into code styling and end without a closing rule — the block
  // read as still open, forever, with nothing saying so. The model does emit
  // these: a reply cut short by a token limit ends mid-fence, and reasoning
  // text quotes fences it never closes.
  //
  // This is also the invariant a streaming renderer would need, and it is the
  // one opencode's split-footer mode solves by holding an unstable markdown
  // block back until it closes (scrollback.surface.ts:278-307). It cannot hold
  // anything back here, because a frame is re-rendered rather than committed —
  // so it says what happened instead.
  if (inFence) {
    lines.push(dim(`${GLYPHS.hLine.repeat(3)} unclosed code block ${GLYPHS.hLine.repeat(Math.max(0, width - 24))}`));
  }
  return lines;
}

// A bare URL, allowing one level of balanced parentheses so a link to
// `.../URL_(disambiguation)` is not cut at the first `)`.
const BARE_URL = /https?:\/\/[^\s<>()\[\]"'`]+(?:\([^\s<>()"'`]*\)[^\s<>()\[\]"'`]*)*/g;
const MD_LINK = /\[([^\]\n]{1,80})\]\((https?:\/\/[^\s)]+(?:\([^\s)]*\)[^\s)]*)*)\)/g;

// The longest label a link may show. Anything longer would reach wrap()'s
// hard-split branch, which cuts a long unbroken token by column — and cutting
// through an OSC 8 sequence leaves the link open across the break.
const MAX_LINK_LABEL = 48;

/** Trailing sentence punctuation belongs to the sentence, not to the URL. */
function trimUrlPunctuation(url) {
  let depth = 0;
  for (let index = 0; index < url.length; index++) {
    const character = url[index];
    if (character === '(') depth++;
    else if (character === ')') {
      if (depth === 0) return trimUrlPunctuation(url.slice(0, index));
      depth--;
    }
  }
  return url.replace(/[?!.,:;*_~]+$/u, '');
}

/** `https://docs.example.com/a/very/long/path?x=1` → `docs.example.com/a/…`. */
function compactUrlLabel(url) {
  let label = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (label.length > MAX_LINK_LABEL) label = label.slice(0, MAX_LINK_LABEL - 1) + GLYPHS.ellipsis;
  return label;
}

/**
 * Inline emphasis, code spans and links.
 *
 * Links are stashed as \u0000N\u0000 placeholders before the emphasis passes run
 * and substituted back afterwards, so an escape sequence can never be matched
 * by the code-span or bold regex. The placeholder is safe because this function
 * only ever sees text that has been through text.safeDisplay(), and sanitize()
 * strips \x00 — so a model cannot forge one.
 *
 * Every URL goes through theme.safeLink(), which re-serialises it from a parsed
 * URL object and refuses anything that is not plain http/https.
 */
function inline(text) {
  const stashed = [];
  const stash = (rendered) => `\u0000${stashed.push(rendered) - 1}\u0000`;

  let out = String(text);

  if (HAS_HYPERLINKS) {
    out = out.replace(MD_LINK, (whole, label, url) => {
      const target = trimUrlPunctuation(url);
      const shown = label.length > MAX_LINK_LABEL
        ? label.slice(0, MAX_LINK_LABEL - 1) + GLYPHS.ellipsis
        : label;
      const rendered = safeLink(paint('accent', shown), target);
      return rendered === paint('accent', shown) ? whole : stash(rendered);
    });
    out = out.replace(BARE_URL, (whole) => {
      const target = trimUrlPunctuation(whole);
      const tail = whole.slice(target.length);
      const rendered = safeLink(paint('accent', compactUrlLabel(target)), target);
      // safeLink returns its input untouched when the URL does not clear the
      // bar; in that case leave the original text exactly as written.
      return rendered.includes('\x1b]8') ? stash(rendered) + tail : whole;
    });
  } else {
    // No OSC 8 here, so a markdown link must still show where it points.
    out = out.replace(MD_LINK, (whole, label, url) => `${label} (${url})`);
  }

  out = HAS_COLOR
    ? out
        .replace(/`([^`]+)`/g, (m, code) => paint('accent', code))
        .replace(/\*\*([^*]+)\*\*/g, (m, strong) => bold(strong))
    : out.replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1');

  if (stashed.length > 0) {
    out = out.replace(/\u0000(\d+)\u0000/g, (m, index) => stashed[Number(index)] || '');
  }
  return out;
}

export class ChatRenderer {
  constructor(options = {}) {
    this.out = options.out || process.stdout;
    this.isTTY = Boolean(this.out.isTTY);
    this.stepCount = 0;
    this.stepStartedAt = null;
    this.spinnerTimer = null;
    this.spinnerIndex = 0;
    this.currentStatus = '';
    this.pendingApprovals = new Map();
    this.status = new StatusLine();
    this.turnStartedAt = null;

    // Full-screen mode owns both of these. The shell hands the renderer the
    // width of the transcript viewport (which is not the terminal width — a
    // border and a gutter come off it), and takes the status message for its
    // footer so no spinner is ever animated into the transcript itself.
    this.widthOf = typeof options.width === 'function' ? options.width : null;
    this.quietStatus = Boolean(options.quietStatus);
    this.onStatusChange = options.onStatusChange || null;

    // Stage mode. When a Transcript is attached the renderer stops being a
    // formatter into stdout and becomes a producer of re-renderable frames:
    // rows go into the model, and the Stage decides which of them are on
    // screen. Null keeps every byte on the path it has always taken.
    this.transcript = options.transcript || null;
    // Set only while a frame is being produced. write() collects into it
    // instead of reaching the terminal.
    this.rowSink = null;
    // Set only while a frame is being RE-produced at a width that is not the
    // terminal's — a reflow after a resize, or a measurement in a test.
    this.forcedWidth = 0;
  }

  write(line = '') {
    // Producing a frame: the rows belong to the model, not to the terminal.
    if (this.rowSink) { this.rowSink.push(line); return; }

    // Stage mode: a direct write is a caller that formatted its own rows —
    // /report, /mcp, the home status card. It cannot be allowed to reach stdout,
    // because the band occupies the bottom of the screen and a bare write lands
    // in the middle of it. Wrapped as a frame, it scrolls with everything else.
    //
    // The text is captured, not re-derived, so this is a pure producer: these
    // callers have already committed to a width and cannot be asked for another.
    if (this.transcript) {
      const text = String(line);
      this.transcript.append({ kind: 'notice', produce: () => text.split('\n') });
      return;
    }

    // The prompt occupies the bottom rows of the terminal. It has to lift them
    // out of the way before the transcript prints and put them back after, or
    // the two writers interleave and leave debris on screen. Nothing is
    // attached in non-interactive mode, where both hooks stay undefined.
    if (this.onBeforeWrite) this.onBeforeWrite();
    this.out.write(line + '\n');
    if (this.onAfterWrite) this.onAfterWrite();
  }

  /**
   * Record one transcript frame, or print it — whichever mode we are in.
   *
   * `produce` must be a PURE function of width. Every value that depends on
   * wall-clock time or on renderer state (the step number, an elapsed
   * duration, the model name at the time) has to be resolved by the caller
   * before the closure is built, because the closure is called again on every
   * resize. That is why the handlers below mutate first and render second: it
   * is not style, it is the contract the Transcript rests on.
   *
   * In scrollback mode this is `produce()` and nothing else, so the byte
   * stream is identical to what it has always been.
   */
  frame(kind, produce, meta = null) {
    if (!this.transcript) { produce(); return; }
    this.transcript.append({
      kind,
      meta,
      produce: (width) => this.capture(width, produce)
    });
  }

  /**
   * Run a producer with write() redirected and the width pinned.
   */
  capture(width, produce) {
    const sink = [];
    const previousSink = this.rowSink;
    const previousWidth = this.forcedWidth;
    this.rowSink = sink;
    this.forcedWidth = width;
    try {
      produce();
    } finally {
      this.rowSink = previousSink;
      this.forcedWidth = previousWidth;
    }
    return sink;
  }

  /**
   * Columns available on the stream this renderer actually writes to.
   *
   * This used to fall straight through to terminalWidth(), which reads the
   * global process.stdout.columns. That is right in production — `out` IS
   * stdout — but it means the renderer cannot be measured against anything
   * else, and every row it produces is sized from the wrong width the moment it
   * is pointed at another stream. ChatPrompt.width() already reasons this way
   * for exactly the same reason; the two now agree.
   */
  width() {
    // A reflow asks "what would this frame look like at 96 columns" about rows
    // that were produced when the terminal was 200 wide. The pinned width has
    // to win over every other source, or a resize re-renders at the old width
    // and the viewport silently misreports its own height.
    if (this.forcedWidth) return Math.max(40, this.forcedWidth);
    if (this.widthOf) return this.widthOf();
    const columns = this.out && this.out.columns;
    return Number.isFinite(columns) && columns > 0 ? Math.max(40, columns) : terminalWidth();
  }

  /**
   * The width PROSE is wrapped to — narrower than the terminal on a wide one.
   *
   * Chrome fills the window; paragraphs must not. See readableWidth() in
   * theme.js for why, and note the two are deliberately different so that
   * stretching the window widens the box without turning the agent's replies
   * into 200-character lines.
   */
  measure() {
    return readableWidth(this.width());
  }

  // -------------------------------------------------------------------------
  // Session framing
  // -------------------------------------------------------------------------

  /**
   * The context the CLI never showed. Which model is about to spend the user's
   * money, in which autonomy mode, over which paths.
   */
  /**
   * Returns the width of the widest row it wrote.
   *
   * The Stage lays its opening composition out to this, so the input box below
   * the banner ends where the banner's text ends instead of stretching past it.
   * MEASURED rather than guessed, because the banner is adaptive: it drops hints
   * and truncates the workspace list to fit whatever width it is given, so its
   * natural width depends on the user's own paths and cannot be a constant. At
   * 156 columns it comes out at 122 — and composing it AT 117 already hides
   * ~/Causyne, which is why the banner is never the thing that gets narrowed.
   */
  sessionHeader(info = {}) {
    // The status line shows the same facts during the turn, where the header
    // has already scrolled away. Mutation first: the closure below runs again
    // on every reflow and must not re-apply it.
    this.status.setSession(info);

    // Tap the rows on their way past, without disturbing either sink.
    const seen = [];
    const write = this.write.bind(this);
    this.write = (line = '') => { seen.push(line); return write(line); };
    try {
      this.frame('session', () => this.renderSessionHeader(info));
    } finally {
      this.write = write;
    }

    let widest = 0;
    for (const line of seen) widest = Math.max(widest, visibleWidth(String(line)));
    return widest;
  }

  renderSessionHeader(info = {}) {
    const width = this.width();

    // ONE block: the wordmark with the session facts set beside it, then one
    // hint row. This used to be the art, a blank, a bordered panel of four
    // label/value rows, a command count, a blank and a separate key-hint row —
    // nineteen rows of chrome before the user could type. Both references open
    // in eight or fewer, with the identity and the facts as a single object.
    this.write();
    for (const row of sessionBanner(info, width)) this.write(row);
    this.write();

    const hints = [
      `${info.commandCount || 0} commands`, '/help', 'enter send',
      'alt+enter newline', 'ctrl+p palette', 'esc interrupt', 'exit to leave'
    ];
    const separator = `  ${GLYPHS.dot}  `;
    const kept = hints.slice();
    while (kept.length > 1 && visibleWidth(kept.join(separator)) > width - 1) kept.pop();
    this.write(dim(kept.join(separator)));
    this.write();
  }

  /**
   * Closing line for one turn: who answered, on what, in how long.
   *
   * The reference closes each exchange with `▪ Build · MiMo V2.5 Free · 5.8s`
   * (screenshot 15.02.21) — a filled marker, the agent, the model, the elapsed
   * time. It is the seam that says "this exchange is finished", which a list of
   * four dim hints never did.
   */
  turnFooter(durationMs) {
    // Resolved now, not inside the closure: by the time a resize re-renders
    // this frame the step counter has been reset and the model may have been
    // switched, and a turn footer that reports the CURRENT state instead of
    // the state it closed is a lie that only appears after a resize.
    const model = this.status.model;
    const steps = this.stepCount;

    this.frame('turn', () => {
      const parts = [];
      if (model) parts.push(paint('ink', model));
      parts.push(`${steps} step${steps === 1 ? '' : 's'}`);
      parts.push(formatDuration(durationMs));

      const separator = dim(`  ${GLYPHS.dot}  `);
      this.write();
      this.write(`${paint('accent', GLYPHS.step)} ${dim(parts.join(separator))}`);
      this.write(dim(`  /usage for cost  ${GLYPHS.dot}  /undo to roll back`));
      this.write();
    }, { steps, durationMs });
  }

  resetTurn() {
    this.stepCount = 0;
    this.stepStartedAt = null;
    this.turnStartedAt = Date.now();
    this.status.reset();
  }

  // -------------------------------------------------------------------------
  // Spinner — only where it can be erased again
  // -------------------------------------------------------------------------

  startSpinner(message) {
    this.stopSpinner();
    this.currentStatus = safeDisplay(message);

    // In full-screen mode the status belongs to the footer, which repaints on
    // the shell's own frame clock. Animating here too would write a spinner
    // into the scrollback of a transcript that is already being repainted.
    if (this.quietStatus) {
      if (this.onStatusChange) this.onStatusChange(this.currentStatus);
      return;
    }

    // A spinner needs cursor control. Piped into a file or a CI log there is no
    // cursor, and the animation becomes thousands of junk lines — so print the
    // status once instead.
    if (!this.isTTY) {
      this.write(paint('muted', this.status.renderStatic(this.currentStatus, this.width())));
      return;
    }

    // Elapsed is measured from the START OF THE TURN, not from this spinner.
    // A forty-step run restarts the spinner on every frame, so a per-spinner
    // clock would reset to 0.0s each time and never show the real wait.
    const since = this.turnStartedAt || Date.now();

    this.spinnerTimer = setInterval(() => {
      readline.cursorTo(this.out, 0);
      const frame = GLYPHS.spinner[this.spinnerIndex % GLYPHS.spinner.length];
      this.out.write(this.status.render({
        message: this.currentStatus,
        elapsedMs: Date.now() - since,
        steps: this.stepCount,
        width: this.width() - 1,
        spinnerFrame: frame
      }));
      readline.clearLine(this.out, 1);
      this.spinnerIndex++;
    }, 90);
  }

  stopSpinner() {
    if (this.quietStatus) {
      this.currentStatus = '';
      if (this.onStatusChange) this.onStatusChange('');
      return;
    }
    if (!this.spinnerTimer) return;
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = null;
    if (this.isTTY) {
      readline.clearLine(this.out, 0);
      readline.cursorTo(this.out, 0);
    }
  }

  // -------------------------------------------------------------------------
  // Frames
  // -------------------------------------------------------------------------

  onAgentMessage(msg) {
    const content = safeDisplay(msg.content || '');
    this.frame('assistant', () => {
      // Prose, not chrome: wrapped to a readable measure even on a wide terminal.
      const width = this.measure();
      this.write();
      this.write(`${paint('agent', GLYPHS.arrow)} ${bold(paint('agent', 'Causyne'))}`);
      for (const line of renderMarkdown(content, width - 2)) {
        this.write(line ? '  ' + line : '');
      }
      this.write();
    });
  }

  /**
   * The chain of thought the user paid for.
   *
   * This frame was emitted by the loop (agentLoop.js:1113) and handled by
   * NOBODY — not here, not in the Android app. openai-compatible.js was fixed
   * to stop discarding `reasoning_content` because "the reasoning the user paid
   * for never reached them", and then it was discarded one layer further down.
   *
   * It is rendered subordinate to the answer on purpose: a dim rule and a cap.
   * Reasoning that shouts as loudly as the reply trains the user to read
   * neither, and the reply is the part they asked for.
   */
  onAgentReasoning(msg) {
    const content = safeDisplay(msg.content || '');
    if (!content.trim()) return;
    this.frame('reasoning', () => this.renderReasoning(content), { reasoning: true });
  }

  renderReasoning(content) {
    const width = this.measure();
    const rows = wrapBlock(content, Math.max(20, width - 4));

    this.write();
    this.write(`${paint('muted', GLYPHS.vLine)} ${dim('thinking')}`);
    for (const row of rows.slice(0, REASONING_LINES)) {
      this.write(`${paint('rule', GLYPHS.vLine)} ${dim(row)}`);
    }
    if (rows.length > REASONING_LINES) {
      const hidden = rows.length - REASONING_LINES;
      this.write(`${paint('rule', GLYPHS.corner)} ${dim(`${GLYPHS.ellipsis} ${hidden} more line${hidden === 1 ? '' : 's'} of reasoning`)}`);
    }
    this.write();
  }

  onAgentPlan(msg) {
    if (!Array.isArray(msg.plan) || msg.plan.length === 0) return;
    const plan = msg.plan.slice();
    this.frame('plan', () => this.renderPlan(plan), { items: plan.length });
  }

  renderPlan(plan) {
    const width = this.width();
    this.write();
    this.write(paint('muted', 'plan'));
    for (const item of plan) {
      const done = item.status === 'completed';
      const active = item.status === 'in_progress';
      const mark = done ? paint('success', GLYPHS.check)
        : active ? paint('accent', GLYPHS.arrow)
        : paint('muted', GLYPHS.dot);
      const label = done ? dim(safeDisplay(item.text)) : paint('ink', safeDisplay(item.text));
      this.write(`  ${mark} ${truncate(label, width - 5, GLYPHS.ellipsis)}`);
    }
    this.write();
  }

  onStepStart(msg) {
    this.stepStartedAt = Date.now();
    this.stepCount++;

    const { verb, detail } = describeTool(msg.tool, msg.args);
    const step = this.stepCount;

    this.frame('step', () => {
      const width = this.width();
      const index = paint('muted', String(step).padStart(2, '0'));
      const name = paint('accent', padEnd(verb || msg.tool, STATUS_GUTTER));

      const used = 2 + 2 + 1 + Math.max(visibleWidth(verb || msg.tool), STATUS_GUTTER) + 1;
      const detailText = detail ? paint('ink', truncate(detail, Math.max(10, width - used - 12), GLYPHS.ellipsis)) : '';

      this.write(`${paint('muted', GLYPHS.arrow)} ${index} ${name} ${detailText}`);
    }, { step, tool: msg.tool });
  }

  onStepComplete(msg) {
    const elapsed = this.stepStartedAt ? formatDuration(Date.now() - this.stepStartedAt) : '';
    const result = msg.result || {};

    // Kept so Ctrl+O can show the whole thing, and set here rather than inside
    // the closure — a reflow must not re-point "the last output" at a tool
    // result the user finished with ten turns ago.
    this.captureLastOutput(result);

    this.frame('result', () => {
      if (result.success) {
        this.write(`     ${paint('success', GLYPHS.check)} ${dim(elapsed)}`);
        this.renderOutputPreview(result);
        return;
      }
      this.write(`     ${paint('danger', GLYPHS.cross)} ${paint('danger', truncate(safeDisplay(result.error || 'failed'), this.width() - 12, GLYPHS.ellipsis))} ${dim(elapsed)}`);
    }, { success: Boolean(result.success) });
  }

  /**
   * A bounded look at what the tool actually returned.
   *
   * The old renderer printed only a tick, so the user never saw any tool output
   * at all — they were approving and trusting blind.
   */
  /**
   * Print the last tool output in full — bound to Ctrl+O.
   *
   * The preview is deliberately twelve lines, which is right until it is not.
   * Before this the cut was permanent and the only recovery was re-running the
   * tool, which costs tokens to see something already fetched.
   */
  expandLastOutput() {
    if (!this.lastOutput || !this.lastOutput.text) {
      this.frame('notice', () => this.write(dim('  nothing to expand')));
      return false;
    }
    // Bound to the output as it is NOW. Ctrl+O twice, ten turns apart, must
    // leave two frames showing two different outputs, not one shown twice.
    const output = this.lastOutput;
    this.frame('result', () => {
      const width = this.width() - 7;
      this.write('');
      for (const line of String(output.text).split('\n')) {
        for (const part of wrap(safeDisplay(line), width)) {
          this.write(`     ${paint('rule', GLYPHS.vLine)} ${dim(part)}`);
        }
      }
        if (output.spillPath) {
        this.write(this.clipHint(output.spillPath));
      }
      this.write('');
    }, { expanded: true });
    return true;
  }

  /**
   * Remember the payload Ctrl+O expands. Separate from rendering it, because
   * rendering runs again on every reflow and this must not.
   */
  captureLastOutput(result = {}) {
    const payload = typeof result.output === 'string' ? result.output
      : typeof result.log === 'string' ? result.log
      : '';
    if (!payload) return;
    this.lastOutput = { text: payload, spillPath: result.spillPath || null };
  }

  renderOutputPreview(result) {
    const payload = typeof result.output === 'string' ? result.output
      : typeof result.log === 'string' ? result.log
      : '';
    if (!payload) return;

    const source = payload.length > PREVIEW_SOURCE_BUDGET
      ? payload.slice(0, PREVIEW_SOURCE_BUDGET)
      : payload;
    if (!source.trim()) return;

    const width = this.width() - 7;
    const cleaned = safeDisplay(source).replace(/\n{3,}/g, '\n\n').trim();

    // Wrap first, THEN cut — bounding by source newlines lets a single long
    // line through as thousands of wrapped rows.
    const wrapped = [];
    for (const line of cleaned.split('\n')) {
      for (const part of wrap(line, width)) {
        wrapped.push(part);
        if (wrapped.length > PREVIEW_LINES + 1) break;
      }
      if (wrapped.length > PREVIEW_LINES + 1) break;
    }

    for (const line of wrapped.slice(0, PREVIEW_LINES)) {
      this.write(`     ${paint('rule', GLYPHS.vLine)} ${dim(line)}`);
    }
    const clipped = wrapped.length > PREVIEW_LINES || source.length < payload.length;
    if (clipped) this.write(this.clipHint(result.spillPath));
  }

  /**
   * The "there is more than this" footer, fitted to the terminal.
   *
   * It was a fixed string. At 40 columns it came back six columns too wide and
   * wrapped — which in scrollback is merely ugly, and inside the Stage's band is
   * the exact failure the width clamp exists to prevent. Found by sweeping the
   * clamp at stage geometry, not by anyone looking at a narrow terminal.
   *
   * A path is shortened BEFORE it is made into a link, never after: truncate()
   * is escape-aware, but cutting a finished OSC 8 sequence in half leaves the
   * hyperlink open across the break.
   */
  clipHint(spillPath) {
    const corner = paint('rule', GLYPHS.corner);
    // Five spaces of gutter, the corner, and the space after it.
    const room = Math.max(12, this.width() - 8);

    if (spillPath) {
      const label = truncate(shortenHome(spillPath), Math.max(8, room - 13), GLYPHS.ellipsis);
      return `     ${corner} ${dim(`full output: ${fileLink(label, spillPath)}`)}`;
    }

    // Say the shorter true thing rather than the longer half-cut one.
    const full = `${GLYPHS.ellipsis} output truncated — ctrl+o to expand`;
    const short = `${GLYPHS.ellipsis} truncated — ctrl+o`;
    const hint = visibleWidth(full) <= room ? full
      : visibleWidth(short) <= room ? short
      : truncate(full, room, GLYPHS.ellipsis);
    return `     ${corner} ${dim(hint)}`;
  }

  /**
   * A restore point was taken before a tool changed a file.
   *
   * Emitted between the step row and its result, and indented to the result
   * gutter so it reads as part of that step rather than as a new event. Quiet
   * on purpose: it happens on every mutating call, and an aside that shouts as
   * loudly as the work trains the user to read neither.
   */
  onCheckpoint(msg) {
    const where = typeof msg.path === 'string' ? shortenHome(msg.path) : '';
    const count = Number(msg.count) || 1;
    this.frame('checkpoint', () => {
      const label = where
        ? `restore point ${GLYPHS.dot} ${where}`
        : `restore point ${GLYPHS.dot} ${count} file${count === 1 ? '' : 's'}`;
      this.write(`     ${paint('muted', GLYPHS.dot)} ${dim(truncate(label, Math.max(10, this.width() - 8), GLYPHS.ellipsis))}`);
    }, { tool: msg.tool, path: msg.path || null, step: msg.step ?? null, taskId: msg.taskId || null });
  }

  onStepError(msg) {
    // Wrapped and hanging-indented, not written as one long string.
    //
    // Loop-level failures now carry a real explanation across several lines —
    // what could not be reached, why, and what to check. Emitting that as a
    // single write put the continuation lines at column 0, under a marker
    // indented five columns, so the whole block read as unrelated fragments.
    const label = `${msg.tool || ''}`.trim();
    const detail = safeDisplay(`${msg.error || ''}`.trim());
    const head = label ? `${label}  ${detail}` : detail;

    this.frame('error', () => {
      const rows = wrapBlock(head, Math.max(20, this.width() - 7));
      this.write(`     ${paint('danger', GLYPHS.cross)} ${paint('danger', rows[0] || '')}`);
      for (const row of rows.slice(1)) this.write(`       ${dim(row)}`);
    }, { tool: msg.tool });
  }

  /**
   * Keep the approval detail so the prompt can name what is being approved.
   * L6 in the local-path audit: a bare "Proceed?" is not human-in-the-loop.
   */
  onApprovalRequest(msg) {
    this.pendingApprovals.set(msg.toolCallId, msg);

    // When an interactive dialog will ask the question, DO NOT also print the
    // whole request into the transcript. It shipped doing both: the same risk
    // badge, command and diff appeared once in the scrollback and again inside
    // the modal, so the user read the same alarming block twice and the panel
    // looked like a duplicate of a thing that had already happened.
    //
    // The transcript still gets a record — see renderApprovalDecision(), which
    // writes ONE line after the user answers. That is the audit trail; the
    // panel is the question. Printing the question twice is not an audit trail.
    if (this.dialogWillAsk) return;

    // The diff is resolved ONCE, here, and closed over.
    //
    // approvalDiff() reads the file from disk. If it ran from inside the
    // producer, a resize would re-read the file — and by then the write has
    // been approved and applied, so the transcript would show the user a diff
    // of the change against itself. A record of what someone consented to may
    // not be re-derived from the world after they consented.
    const diff = approvalDiff(msg.tool, msg.args, { width: this.width() });

    this.frame('approval', () => this.renderApprovalRequest(msg, diff), {
      tool: msg.tool,
      risk: String(msg.risk || 'unknown').toUpperCase()
    });
  }

  renderApprovalRequest(msg, diff = undefined) {
    // Colour carries the tier; the word never reaches the user. See the note
    // in dialogs.js ApprovalLayer — 'DANGEROUS' printed at somebody installing a
    // package teaches them to stop reading these.
    const risk = String(msg.risk || 'unknown').toUpperCase();
    const role = risk === 'EXTREME' ? 'danger' : risk === 'DANGEROUS' ? 'warn' : 'accent';
    const { verb, detail } = describeTool(msg.tool, msg.args);

    this.write();
    this.write(`${paint(role, GLYPHS.warnMark)} ${paint('ink', 'permission required')}  ${bold(safeDisplay(msg.tool || ''))}${verb ? dim(`  ${verb}`) : ''}`);
    if (detail) {
      this.write(`  ${paint('ink', truncate(detail, this.width() - 4, GLYPHS.ellipsis))}`);
    }

    // What the user is actually consenting to. Without this the approval gate
    // asks a human to authorise a file mutation they have never seen — which is
    // consent in form only. null for every tool that does not change a file.
    //
    // Resolved by the caller so it is computed once, at the moment consent was
    // asked for; a direct caller that passes nothing still gets the live read.
    if (diff === undefined) diff = approvalDiff(msg.tool, msg.args, { width: this.width() });
    if (diff) {
      const stat = [
        diff.added ? paint('success', `+${diff.added}`) : '',
        diff.removed ? paint('danger', `-${diff.removed}`) : ''
      ].filter(Boolean).join(' ');
      const note = diff.note ? dim(`  ${GLYPHS.dot}  ${diff.note}`) : '';
      // The detail row above already names the file; repeating it here just
      // prints the same path twice. Only fall back to the diff's own path when
      // the tool had no readable detail to show.
      const where = detail ? '' : `${dim(diff.path)}  `;
      this.write(`  ${where}${stat}${note}`);
      this.write();
      for (const row of diff.rows) this.write(row);
      if (diff.clipped) {
        this.write(`     ${paint('rule', GLYPHS.corner)} ${dim(`${GLYPHS.ellipsis} diff truncated`)}`);
      }
      this.write();
    }
  }

  /**
   * One line recording what the user actually decided.
   *
   * Written AFTER the answer, so the scrollback reads as history rather than
   * as a second copy of the prompt. Only used when a dialog asked the
   * question; the non-interactive path still prints the full block, because
   * there the scrollback IS the only place the request was ever shown.
   */
  renderApprovalDecision(msg, approved, scope = 'once') {
    // A standing grant must be VISIBLE in the transcript. Someone who lifts the
    // gate for a whole session should be able to scroll back and see that they
    // did, and `/approvals` tells them how to take it back.
    const verdict = !approved
      ? paint('danger', 'rejected')
      : scope === 'always'
        ? paint('warn', 'allowed always')
        : paint('success', 'allowed once');
    const { verb } = describeTool(msg.tool, msg.args);
    this.frame('approval', () => {
      this.write(`  ${verdict} ${bold(safeDisplay(msg.tool || ''))}${verb ? dim(`  ${verb}`) : ''}`);
    }, { tool: msg.tool, approved: Boolean(approved), scope });
  }

  onError(msg) {
    const message = safeDisplay(msg.message || '');
    this.frame('error', () => {
      this.write();
      this.write(`${badge('danger', 'ERROR')} ${paint('danger', message)}`);
      this.write();
    });
  }

  onBudgetWarning(msg) {
    const message = safeDisplay(msg.message || '');
    this.frame('notice', () => {
      this.write(`${badge('warn', 'BUDGET')} ${paint('warn', message)}`);
    }, { tone: 'warn' });
  }

  onStatus(msg) {
    this.startSpinner(msg.message || '');
  }

  /**
   * A skill was invoked — say so in one line, do not print the skill.
   *
   * The reported behaviour: invoking a skill dumped the whole SKILL.md into the
   * terminal, frontmatter and all, and that was the ENTIRE effect. None of the
   * references do that — a skill is a working method the model follows, not a
   * document it reads back at you. The body now goes into the request; what the
   * user sees here is a marker that it was picked up, in the same shape as a
   * step row.
   */
  skillInvoked(id, instruction) {
    this.frame('skill', () => {
      const width = this.width();
      const head = `${paint('accent', GLYPHS.step)} ${bold(paint('ink', 'skill'))}`
        + `${dim(`  ${GLYPHS.dot}  `)}${paint('agent', safeDisplay(id))}`;
      this.write();
      this.write(truncate(head, width - 1, GLYPHS.ellipsis));
      if (instruction) {
        for (const line of wrapBlock(safeDisplay(instruction), width - 4)) {
          this.write(dim(`  ${line}`));
        }
      }
    }, { skill: String(id || '') });
  }

  /**
   * A one-line aside from the loop: tier, packs, compaction, a cache hit.
   *
   * These were bare console.log calls in agentLoop.js — a second writer to a
   * terminal whose bottom rows the prompt repaints in place, which is why they
   * left debris. Routed here they pass through write(), so the live region is
   * lifted out of the way first and put back after, and they inherit the theme
   * instead of carrying a hardcoded \x1b[1m\x1b[36m that ignored NO_COLOR.
   *
   * Deliberately quiet: a dim marker and one wrapped line. An aside that shouts
   * as loudly as the agent's answer trains the user to stop reading both.
   */
  onNotice(msg) {
    const tone = ['accent', 'success', 'warn', 'muted'].includes(msg.tone) ? msg.tone : 'muted';
    const message = safeDisplay(msg.message || '');
    this.frame('notice', () => {
      const width = this.measure();
      const marker = paint(tone === 'muted' ? 'rule' : tone, GLYPHS.vLine);
      for (const line of wrapBlock(message, width - 2)) {
        this.write(`${marker} ${dim(line)}`);
      }
    }, { tone });
  }

  /**
   * Route one frame. Returns true when handled.
   *
   * Unknown frame types are ignored rather than printed raw — the loop emits
   * several the terminal has no business showing (usage_update, task_complete).
   */
  handle(msg) {
    if (!msg || typeof msg.type !== 'string') return false;
    if (msg.type !== 'status') this.stopSpinner();

    switch (msg.type) {
      case 'status':           this.onStatus(msg); return true;
      case 'agent_message':    this.onAgentMessage(msg); return true;
      case 'agent_reasoning':  this.onAgentReasoning(msg); return true;
      case 'agent_plan':       this.onAgentPlan(msg); return true;
      case 'step_start':       this.onStepStart(msg); return true;
      case 'step_complete':    this.onStepComplete(msg); return true;
      case 'step_error':       this.onStepError(msg); return true;
      case 'checkpoint':       this.onCheckpoint(msg); return true;
      case 'approval_request': this.onApprovalRequest(msg); return true;
      case 'error':            this.onError(msg); return true;
      case 'budget_warning':   this.onBudgetWarning(msg); return true;
      case 'notice':           this.onNotice(msg); return true;
      // Not printed — it feeds the live status line, which is where a running
      // token and cost total belongs. Printing it would interleave a counter
      // into the transcript on every single model response.
      case 'usage_update':     this.status.onUsage(msg); return true;
      default:                 return false;
    }
  }
}
