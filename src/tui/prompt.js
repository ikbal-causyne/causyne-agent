// The chat prompt: raw keyboard, live redraw, completion, history, queueing.
//
// This is what replaces `inquirer.prompt({ type: 'input' })`. inquirer answered
// one question at a time and owned the terminal while it did, which is why the
// chat could not offer history, could not complete a command, could not accept
// a paragraph, and went deaf the moment the agent started working.
//
// Three behaviours here are the ones a user actually feels:
//
//  * TYPE WHILE BUSY — keystrokes during a turn are kept and sent when it ends,
//    instead of being swallowed by a terminal nobody is reading.
//  * ESC INTERRUPTS — wired to the AgentLoop.abort() that already existed and
//    was only reachable by typing /stop after the turn had finished.
//  * FAIL OPEN — if raw mode is unavailable (piped stdin, a CI runner, an
//    unusual terminal) the caller falls back to plain readline. A fancy editor must
//    never be the reason chat does not start.
//
// Pure Node. No dependency, no shell.

import { KeyDecoder, bracketedPaste } from './keys.js';
import { LineEditor } from './lineEditor.js';
import { PromptHistory } from './history.js';
import { FileIndex, suggest, applyCompletion, detectTrigger, renderPicker, MAX_VISIBLE } from './completion.js';
import { paint, dim, bold, GLYPHS, terminalWidth, HAS_COLOR } from './theme.js';
import { barBlock, GUTTER } from './block.js';
import { visibleWidth, truncate, wrapBlock, shortenHome, safeDisplay } from './text.js';
import { pickExample, fitHints } from './banner.js';
import { panelRows } from './overlay.js';
import { commandPalette, skillPicker, ApprovalLayer, DecisionLayer, ConfirmLayer, HomeLayer, TextLayer } from './dialogs.js';
import { describeTool } from './toolDisplay.js';
import { readClipboardSync, writeClipboardSync } from './clipboardSync.js';
import { handleViewportWheel, handleScrollbarMouse } from './scrollInteraction.js';
import { centerRows, sessionRows, dialogWidth, dialogHeight } from './layout.js';
import { settleStageResize } from './resizeRecovery.js';
import { sidebarVisible, sessionMainWidth } from './sessionSidebar.js';
import { isStartupDialog, startupDialogView } from './homeView.js';
import { handleMessageMouse, handleMessageActionMenuMouse, isMouseMotion } from './messageInteraction.js';
import {
  resetTurnInterruptState,
  shouldAcceptStatusUpdate,
  triggerTurnInterrupt,
  handlePromptCtrlC,
  handlePromptEscape
} from './composerControls.js';

const CTRL_C_WINDOW_MS = 2000;

// Rows the editor may occupy before it starts scrolling internally.
//
// Without a cap, pasting a 200-line file draws 200 rows and erase() then walks
// 200 rows back up every keystroke. The live region has to stay small enough
// that the conversation above it is never pushed off the screen.
const MAX_PROMPT_ROWS = 8;

// How long to wait for a resize gesture to settle before repainting.
//
// A window drag delivers a resize event per step — dozens per second. Painting
// the live region on each one is what filled the screen with overlapping copies
// of the input row. One repaint per gesture is both correct and invisible to the
// user at this delay.
const RESIZE_SETTLE_MS = 60;

// Air. The two rows that were missing.
//
// opencode's prompt box carries paddingTop={1} INSIDE its filled surface and a
// one-row bordered spacer between the box and the footer
// (component/prompt/index.tsx:1361-1363, :1487-1497). Causyne had neither: the
// caret sat on the very first row of the fill and the footer was welded to the
// bottom of the box, which is what made the whole thing read as jammed into the
// last four rows of the terminal.
//
// They are constants rather than magic numbers in the layout because the caret
// row is computed from them — get that wrong and the cursor parks on the wrong
// line, which is the class of bug erase() exists to prevent.
const PROMPT_PAD_TOP = 1;
const PROMPT_PAD_BOTTOM = 1;
const FOOTER_GAP = 1;

// Air is what a roomy terminal can afford, and the first thing a cramped one
// gives up.
//
// opencode's spacers carry `minHeight={0} flexShrink={1}` (routes/home.tsx:73-80)
// precisely so they collapse before anything with content does. Causyne has no
// flex engine, so the same idea is arithmetic — and it is not decoration: on a
// 17-row terminal the extra row made the banner plus the band come to exactly 17,
// which costs the top of the wordmark. UX-03's sweep is what caught it.
const ROOMY_TERMINAL_ROWS = 20;
const CRAMPED_TERMINAL_ROWS = 18;

/** Can this process own the keyboard? */
export function isInteractive() {
  if (process.env.CAUSYNE_SIMPLE_INPUT === '1') return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export class ChatPrompt {
  constructor(options = {}) {
    this.out = options.out || process.stdout;
    this.input = options.input || process.stdin;
    this.root = options.root || process.cwd();
    this.focusDir = options.focusDir || null;
    this.onInterrupt = options.onInterrupt || (() => {});

    // The Stage, when one is running. Null means the scrollback renderer, which
    // is what every non-TTY, dumb terminal and CAUSYNE_STAGE=off session gets.
    this.surface = options.surface || null;
    this.onExit = options.onExit || (() => process.exit(0));
    this.onExpand = options.onExpand || (() => {});
    this.onOpenMode = options.onOpenMode || null;
    this.onOpenModel = options.onOpenModel || null;
    this.onOpenVariant = options.onOpenVariant || null;
    this.messageActionLoop = options.messageActionLoop || null;
    this.getMode = options.getMode || (() => 'B');

    this.editor = new LineEditor();
    this.history = options.history || new PromptHistory();
    this.index = new FileIndex(this.root);
    this.decoder = new KeyDecoder();

    this.busy = false;
    this.active = false;
    this.drawnRows = 0;

    // Which row of the drawn block the caret is parked on.
    //
    // erase() has to walk back up to the FIRST row of the block. It used to
    // assume the caret was on the last one and move up drawnRows - 1 — but
    // draw() deliberately parks it on the editor's cursor row, which is higher
    // whenever a completion picker or a notice is showing, or the caret sits on
    // an earlier line of a multiline message. The difference was walked up past
    // the top of the block and then erased with \x1b[J, destroying that many
    // rows of real conversation above the prompt.
    this.cursorRow = 0;

    // The status row of the live region, and the clock that animates it.
    this.renderer = null;
    this.statusMessage = '';
    this.tick = 0;
    this.tickTimer = null;

    // One concrete example, chosen per session — `ask anything` teaches a new
    // user nothing about what this agent can actually be asked to do.
    this.example = pickExample();

    // Commands for the palette, and the dialog that currently owns the keyboard.
    //
    // Dialogs use the live stage as a centered temporary view and restore the
    // transcript when dismissed. Terminal scrollback is not repainted.
    this.commands = options.commands || [];

    // Is this line a COMMAND rather than a message?
    //
    // Injected rather than imported: commands.js pulls in the compiled skill
    // payload, the MCP registry and the slop detector, and this file's whole
    // premise is that it depends on nothing. The rule still lives in exactly
    // one place (commands.js isCommandInput) — cliMode hands it down.
    this.isCommand = typeof options.isCommand === 'function' ? options.isCommand : () => false;
    this.layer = null;
    this.queue = [];
    this.waiter = null;
    this.completion = null;
    this.selected = 0;
    this.lastCtrlC = 0;
    this.interruptedTurn = false;
    this.notice = '';
    this.redrawScheduled = false;
    this.resizeTimer = null;
    this.suspendedSurface = null;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start() {
    if (this.active) return;
    this.active = true;
    this.input.setRawMode(true);
    this.input.resume();
    this.input.on('data', this.handleData);
    this.out.write(bracketedPaste(true));
    // Rows are laid out against the terminal width; without this they stay stale
    // until the next keystroke, and a narrowed terminal wraps rows that erase()
    // is still counting as one.
    if (typeof this.out.on === 'function') this.out.on('resize', this.handleResize);
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.stopTick();
    if (this.resizeTimer) { clearTimeout(this.resizeTimer); this.resizeTimer = null; }
    this.erase();
    // The exit contract (UX-01 rev 2 clause d): the band collapses and the whole
    // session is flushed into real terminal scrollback, so leaving Causyne leaves
    // a transcript behind exactly as it always has.
    if (this.surface) this.surface.close();
    this.out.write(bracketedPaste(false));
    if (typeof this.out.removeListener === 'function') this.out.removeListener('resize', this.handleResize);
    this.input.off('data', this.handleData);
    try { this.input.setRawMode(false); } catch (e) { /* already closed */ }
    this.input.pause();
  }

  /**
   * The terminal changed size. Take the live region down before redrawing it.
   *
   * This used to zero drawnRows and cursorRow and then schedule a draw. Zeroing
   * the counters is what erase() reads to decide how far to walk back up — so
   * with them at zero it returned IMMEDIATELY and removed nothing, while the
   * caret was still parked mid-block at column 2 from the previous draw. The
   * redraw then wrote a fresh copy starting at that column, on top of a row that
   * already had content.
   *
   * One stale copy per event. Dragging a window emits hundreds, and the result
   * was a screen filled edge to edge with overlapping copies of the input row.
   *
   * Erasing with the pre-resize geometry is approximate — the terminal has
   * already reflowed what we drew — but approximate removal is categorically
   * better than none, and the debounce below means it happens once per gesture
   * instead of once per pixel.
   */
  handleResize = () => {
    if (!this.resizeTimer) this.erase();
    // The Stage owns its own geometry and cannot repaint a band whose height it
    // no longer knows. Resizing it here, before the settle timer, would do it
    // once per pixel of a drag; it is done in the settled callback below.
    // A drag delivers a continuous stream of these. Redrawing on every one is
    // both the corruption above and a huge amount of pointless output; settle
    // first, then draw once.
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      // Geometry from before the reflow is meaningless now. Drop it AFTER the
      // erase above has used it, not before.
      this.drawnRows = 0;
      this.cursorRow = 0;
      // A stage that can no longer fit gives the band back and hands the
      // session to the scrollback renderer rather than painting into a region
      // too short to hold a viewport.
      const settled = settleStageResize(this.surface, this.suspendedSurface);
      this.surface = settled.current;
      this.suspendedSurface = settled.suspended;
      if (settled.restored) this.attachSurface(settled.current);
      this.draw();
    }, RESIZE_SETTLE_MS);
    if (this.resizeTimer.unref) this.resizeTimer.unref();
  };

  handleData = (chunk) => {
    let motionOnly = true;
    for (const key of this.decoder.decode(chunk)) {
      if (key.name !== 'mouse' || !isMouseMotion(key.sequence)) motionOnly = false;
      try {
        this.handleKey(key);
      } catch (e) {
        // A key handler must never take the session down. Say so once and
        // carry on, rather than dying silently the way the old catch(e){} did.
        process.stderr.write(`\n[tui] key "${key.name}" failed: ${e.message}\n`);
      }
    }
    // All-motion chunks repaint only when the hovered message actually changes.
    if (!motionOnly) this.draw();
  };

  /**
   * Let the transcript print without fighting the prompt for the same rows.
   *
   * The renderer writes upward from where the cursor is; the prompt lives at the
   * bottom. Without this the two interleave and leave debris on screen.
   */
  attach(renderer) {
    renderer.onBeforeWrite = () => this.erase();
    renderer.onAfterWrite = () => this.scheduleDraw();

    // Take the status line over from the renderer's spinner.
    //
    // That spinner writes straight to stdout with readline.cursorTo(out, 0),
    // which lands on whatever row the caret is on — and after draw() that is a
    // row INSIDE the prompt block. Every 90 ms frame overwrote the prompt's first
    // row and clearLine ate the rest, leaving drawnRows describing a block that
    // was no longer on screen. It also bypassed onBeforeWrite/onAfterWrite
    // entirely, so the prompt never got a chance to lift itself out of the way.
    //
    // The renderer already has the right behaviour for this: the quiet path it
    // uses in full-screen mode, which reports status instead of animating it.
    // Reuse that and make the status a row of the live region.
    this.renderer = renderer;
    if (this.surface) this.surface.sidebarStatus = renderer.status;
    renderer.quietStatus = true;
    renderer.onStatusChange = (message) => {
      if (!shouldAcceptStatusUpdate(this)) return;
      this.statusMessage = message;
      this.scheduleDraw();
    };
    renderer.onPlanChange = (plan) => {
      if (this.surface) this.surface.sidebarPlan = plan;
      this.scheduleDraw();
      return this.surface && sidebarVisible(this.surface.width) ? 'sidebar' : undefined;
    };
  }

  /**
   * The footer row: spinner, elapsed, steps, tokens, cost, model.
   *
   * One clock drives it, and only while a turn is running — an idle prompt costs
   * no timer at all. Rendered through the renderer's own StatusLine so the
   * usage_update counters it accumulates are the ones displayed.
   */
  statusRow(width) {
    if (!this.renderer || !this.renderer.status) return [];
    const status = this.renderer.status;

    // Between turns the working numbers are all zero and the line said "ready"
    // beside a model name — two facts nobody can act on. opencode's permanent
    // footer shows the working directory and what the context window has left,
    // which is what the idle form carries instead.
    if (!this.busy) {
      return [status.renderIdle({
        width: Math.max(10, width),
        hint: this.commands.length > 0 ? 'ctrl+p commands' : ''
      })];
    }

    const frame = GLYPHS.spinner[this.tick % GLYPHS.spinner.length];
    const since = this.renderer.turnStartedAt;
    return [status.render({
      message: this.statusMessage || 'working',
      elapsedMs: since ? Date.now() - since : 0,
      steps: this.renderer.stepCount || 0,
      width: Math.max(10, width - 1),
      spinnerFrame: frame
    })];
  }

  /**
   * The line inside the input box: mode, model, provider.
   *
   * opencode puts exactly this row at the foot of its prompt box
   * (`Build · MiMo V2.5 Free  OpenCode Zen`), and it is the one place the fact
   * that matters most — which model is about to spend the user's money — is
   * visible at the moment they press enter. Causyne showed it once in the session
   * header and then never again.
   */
  agentRow(width) {
    const status = this.renderer && this.renderer.status;
    if (!status) return null;

    const mode = `${this.busy ? 'Working' : 'Build'} ${this.getMode()}`;
    const parts = [bold(paint('accent', mode))];
    if (status.model) parts.push(bold(paint('ink', status.model)));
    const line = parts.join(dim(`  ${GLYPHS.dot}  `));
    const trailing = [status.provider, status.tier].filter(Boolean).join(' ');
    const base = trailing ? `${line}  ${dim(trailing)}` : line;
    const hints = dim('  Ctrl+G mode · Alt+M model · Ctrl+T variant');
    const full = visibleWidth(base) + visibleWidth(hints) <= width ? base + hints : base;
    return visibleWidth(full) > width ? truncate(full, width, GLYPHS.ellipsis) : full;
  }

  /** Persistent checklist shown outside the chat transcript. */
  planRows(width) {
    if (this.surface && sidebarVisible(this.surface.width)) return [];
    const plan = this.renderer && Array.isArray(this.renderer.latestPlan) ? this.renderer.latestPlan : [];
    if (plan.length === 0) return [];
    const completed = plan.filter(item => item.status === 'completed').length;
    const rows = [`${bold(paint('accent', 'implementation plan'))}  ${dim(`${completed}/${plan.length}`)}`];
    const limit = Math.min(plan.length, 5);
    for (const item of plan.slice(0, limit)) {
      const mark = item.status === 'completed'
        ? paint('success', GLYPHS.check)
        : item.status === 'in_progress'
          ? paint('accent', GLYPHS.arrow)
          : paint('muted', GLYPHS.dot);
      rows.push(`  ${mark} ${truncate(safeDisplay(item.text || item.step || ''), Math.max(8, width - 5), GLYPHS.ellipsis)}`);
    }
    if (plan.length > limit) rows.push(`  ${dim(`${GLYPHS.ellipsis} ${plan.length - limit} more`)}`);
    rows.push('');
    return rows;
  }

  startTick() {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      this.tick++;
      if (this.busy) this.scheduleDraw();
    }, 90);
    if (this.tickTimer.unref) this.tickTimer.unref();
  }

  stopTick() {
    if (!this.tickTimer) return;
    clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  openLayer(layer) {
    this.closeLayer();
    this.layer = layer;
    this.draw();
    return layer;
  }

  closeLayer() {
    const layer = this.layer;
    if (!layer) return;
    this.layer = null;
    // Dismissing a question is an ANSWER, and the safe answer is no. A layer that
    // is torn down without one would otherwise leave its promise pending forever
    // and hang the turn.
    if (typeof layer.answer === 'function') layer.answer(false);
    this.draw();
  }

  /** Every command in the app, fuzzy-searchable. */
  openPalette() {
    if (this.commands.length === 0) {
      this.notice = 'no commands available';
      return;
    }
    this.openLayer(commandPalette(this.commands, (command) => {
      // Run it the way the user would have typed it, so there is one execution
      // path for a command however it was reached.
      this.editor.setText(`/${command.name}`);
      this.layer = null;
      this.submit();
    }));
  }

  
  openHome(items, onPick) {
    if (!Array.isArray(items) || items.length === 0) {
      this.notice = 'no actions available';
      this.scheduleDraw();
      return null;
    }
    return this.openLayer(new HomeLayer({
      items,
      onPick: (item) => {
        this.layer = null;
        return onPick ? onPick(item) : null;
      }
    }));
  }

  /**
   * Put text on the input line, ready to be added to.
   *
   * Picking from the skill browser lands here: the command is written for you
   * and the caret sits after it, so the next thing you type is what you want
   * done. A picker that ran the skill on selection would give you no way to say
   * that.
   */
  setText(text) {
    this.editor.setText(String(text == null ? '' : text));
    this.completion = null;
    this.scheduleDraw();
  }

  /** Update active model and provider displayed in agentRow and status footer. */
  updateModel(provider, model) {
    if (this.renderer && this.renderer.status) {
      this.renderer.status.setSession({
        provider: provider ? String(provider) : '',
        model: model ? String(model) : ''
      });
    }
    this.scheduleDraw();
  }

  /**
   * Browse the compiled skill library.
   *
   * 100 skills cannot be a flat listing — that is what overflowed the terminal
   * at five. The picker is the same SelectLayer that already backs ctrl+p, so
   * fuzzy search, grouping and scrolling come for free, and every row is
   * truncated to the panel rather than to the terminal.
   */
  browseSkills(skills, onOpen) {
    if (!Array.isArray(skills) || skills.length === 0) {
      this.notice = 'no skills are compiled into this build';
      this.scheduleDraw();
      return;
    }
    this.openLayer(skillPicker(skills, (skill) => {
      this.layer = null;
      if (onOpen) onOpen(skill);
    }));
  }

  /** Show local command output inside the live region, never in chat scrollback. */
  showText(title, text, options = {}) {
    const panelWidth = dialogWidth(this.width(), options.width || 76);
    const contentWidth = Math.max(12, panelWidth - 4);
    const lines = wrapBlock(safeDisplay(String(text == null ? '' : text)), contentWidth);
    return this.openLayer(new TextLayer({
      title: String(title || 'Details'),
      lines: options.danger ? lines.map((line) => paint('danger', line)) : lines,
      width: panelWidth,
      height: options.height || 20
    }));
  }

  /**
   * Ask for approval of a tool call: risk, arguments and a scrollable diff.
   *
   * Replaces an inquirer.prompt() that took stdin while this prompt was already
   * holding it in raw mode — the two contended, and the confirm could arrive on
   * top of a half-drawn prompt.
   */
  approve(request = {}) {
    return new Promise((resolve) => {
      // Only the curated verb — "run", "overwrite", "delete". The layer already
      // renders the arguments (or a diff) underneath, so passing a rendered
      // argument summary as `detail` printed the same line twice.
      const { verb } = describeTool(request.tool, request.args || {});
      // Resolve with WHICH option was chosen, not just yes/no: 'always' has to
      // reach the caller so it can record a standing approval. A bare boolean
      // would have silently downgraded it to 'once'.
      this.openLayer(new ApprovalLayer({
        request,
        verb,
        onAnswer: (approved, scope) => resolve({ approved, scope: scope || (approved ? 'once' : 'reject') })
      }));
    });
  }

  /** Ask for a durable implementation choice, with a free-form option. */
  decide(request = {}) {
    return new Promise((resolve) => {
      this.openLayer(new DecisionLayer({ request, onAnswer: resolve }));
    });
  }

  /** A plain yes/no, for the questions that are not tool approvals. */
  confirm(message, options = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (answer) => { if (!settled) { settled = true; resolve(Boolean(answer)); } };
      const layer = new ConfirmLayer({
        message,
        defaultAnswer: options.defaultAnswer === true,
        onAnswer: settle
      });
      this.openLayer(layer);
    });
  }

  /**
   * Columns available on the stream this prompt actually writes to.
   *
   * draw() used to call the global terminalWidth(), which reads
   * process.stdout.columns. That is right in production — `out` IS stdout — but
   * it means the widget cannot be measured against anything else, and a panel
   * sized from the wrong width overflows and wraps, which corrupts erase()'s row
   * count and starts eating the conversation above.
   */
  width() {
    // The Stage keeps the composer at one readable measure through the session.
    if (this.surface && typeof this.surface.composeWidth === 'function') {
      const asked = this.surface.composeWidth();
      if (Number.isFinite(asked) && asked > 0) return Math.max(20, asked);
    }

    const columns = this.out && this.out.columns;
    // No ceiling. The prompt is chrome: the box, its fill and the footer are the
    // surface the user is typing into, and they follow the window. A clamp at
    // 120 left a stretched terminal two-thirds covered and one-third empty.
    return Number.isFinite(columns) && columns > 0
      ? Math.max(20, columns)
      : terminalWidth();
  }

  scheduleDraw() {
    if (this.redrawScheduled || !this.active) return;
    this.redrawScheduled = true;
    setImmediate(() => {
      this.redrawScheduled = false;
      this.draw();
    });
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /** Next submitted line. Resolves immediately if one was queued while busy. */
  read() {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  /**
   * Resolve a pending read() with a value nobody typed.
   *
   * The home menu needs this: picking an action must satisfy the same read()
   * the keyboard would have satisfied, or the caller sits waiting for a line
   * that is never coming. It deliberately does NOT echo, add to history or
   * touch the editor — an action is not a message, and showing `start` in the
   * transcript as though the user had said it would be a lie about what
   * happened. If no read is outstanding the value queues, exactly as a typed
   * line would while a turn is running.
   */
  deliver(value) {
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(value);
      return true;
    }
    this.queue.push(value);
    return false;
  }

  setBusy(busy) {
    this.busy = busy;
    resetTurnInterruptState(this, busy);
    if (busy) this.startTick(); else this.stopTick();
    this.draw();
  }

  submit() {
    const text = this.editor.getText();
    if (!text.trim()) return;

    this.erase();
    this.history.add(text);
    this.editor.clear();
    this.completion = null;

    // Control commands take priority over busy turns so the user is never locked out.
    // Commands like /stop, /new, /model, /session, /sessions, /continuum, /clear can interrupt
    // a stalled/long-running turn and execute immediately.
    const isControlCommand = this.isCommand(text) && (
      text === '/stop' || text === '/interrupt' ||
      text.startsWith('/new') ||
      text.startsWith('/model') ||
      text.startsWith('/session') ||
      text.startsWith('/sessions') ||
      text.startsWith('/continuum') ||
      text === '/clear'
    );

    if (isControlCommand && this.busy) {
      this.interrupt();
    }

    if (this.busy) {
      // The turn is still running: hold the line rather than dropping it.
      this.queue.push(text);
      this.notice = `queued (${this.queue.length}) — sends when this turn ends`;
      return;
    }

    // A command is control input, not conversation. Its handler decides whether
    // to open a picker, show a text dialog, or perform an action. Keeping the
    // invocation out of the transcript preserves the boundary between local UI
    // and messages that were actually sent to the model.
    if (this.isCommand(text)) {
      const settle = this.waiter;
      this.waiter = null;
      if (settle) settle(text);
      return;
    }

    // Render live submissions through the same path used when history reflows.
    if (this.surface?.homeInfo) this.surface.leaveHome();
    if (this.renderer?.renderUserMessage) this.renderer.renderUserMessage(text);
    else this.commit('user', (width) => {
      const blockWidth = Math.max(8, width - 1);
      return barBlock(
        wrapBlock(safeDisplay(text), Math.max(8, blockWidth - visibleWidth(GLYPHS.bar) - GUTTER)),
        { width: blockWidth, role: 'user', filled: true, surface: 'surfaceHi' }
      );
    });
    const resolve = this.waiter;
    this.waiter = null;
    if (resolve) resolve(text);
  }

  // -------------------------------------------------------------------------
  // Keys
  // -------------------------------------------------------------------------

  handleKey(key) {
    // The wheel was handed to the terminal at the top of the band; the moment
    // the user types again they are driving this prompt, so take it back.
    if (key.name !== 'wheel' && key.name !== 'mouse'
        && this.surface && typeof this.surface.captureMouse === 'function') {
      if (this.surface.captureMouse() && this.notice.startsWith('top of this view')) this.notice = '';
    }

    if (key.ctrl && key.name === 'c') {
      // A modal owns the screen, so ctrl+c must dismiss THAT before it touches
      // the turn behind it. closeLayer() answers false, which is what makes
      // this safe: the pending approval resolves as a denial.
      //
      // It shipped the other way round. With an approval up, ctrl+c fell
      // straight through to handleCtrlC(), saw `busy`, and interrupted the
      // turn — while the modal stayed on screen and its promise was never
      // resolved. The loop then waited forever for an answer that could no
      // longer be given, which is why ctrl+c "did nothing" and only escape
      // ever got the user out.
      if (this.layer) { this.closeLayer(); return; }
      return this.handleCtrlC();
    }
    if (key.ctrl && key.name === 'd' && this.editor.isEmpty) return this.onExit();

    // A dialog owns the keyboard while it is up — the editor must not also see
    // the keystroke, or typing a filter would edit the message behind it.
    // This MUST route before any default key handling (like paste) so modal
    // dialogs (e.g. InputLayer for API keys) receive bracketed paste events.
    if (this.layer) {
      const previousSelection = this.layer.messageActions ? this.layer.list?.selected : null;
      const action = key.name === 'mouse' && this.layer.messageActions
        ? handleMessageActionMenuMouse(this.layer, key)
        : this.layer.key(key);
      if (this.layer?.messageActions && isMouseMotion(key.sequence)
          && previousSelection !== this.layer.list?.selected) this.scheduleDraw();
      if (action === 'close') { this.closeLayer(); return; }
      // A layer may hand a key BACK rather than swallow it. The home menu does
      // this for every printable character, so `↑↓` picks an action while typing
      // goes to the input line in the same frame: 'dismiss' closes the menu and
      // lets the key through, 'passthrough' leaves the menu up and lets it
      // through. Silence still means "mine, ignored", so every other layer stays
      // strictly modal — a dialog that leaks keys is the bug Layer exists to
      // prevent, and only a layer that opts in by name can do it.
      if (action === 'dismiss') this.closeLayer();
      else if (action !== 'passthrough') return;
    }

    if (key.name === 'paste') {
      this.editor.insert(key.text);
      this.refreshCompletion();
      return;
    }

    if (this.completion && this.handleCompletionKey(key)) return;
    if (this.handleScrollKey(key)) return;

    const control = key.ctrl && key.name === 'g' ? this.onOpenMode
      : key.alt && key.name === 'm' ? this.onOpenModel
      : key.ctrl && key.name === 't' ? this.onOpenVariant : null;
    if (control) {
      if (this.busy) {
        this.notice = 'Finish or interrupt the current turn before switching controls';
        this.scheduleDraw();
      } else {
        Promise.resolve(control()).catch(error => {
          this.notice = error instanceof Error ? error.message : String(error);
          this.scheduleDraw();
        });
      }
      return;
    }

    switch (key.name) {
      case 'escape': return this.handleEscape();
      case 'enter':
        if (key.alt) { this.editor.newline(); return; }
        return this.submit();
      case 'tab':
        if (key.shift) return;
        return this.openCompletion(true);
      case 'backspace':
        if (key.alt) this.editor.killWordLeft(); else this.editor.backspace();
        return this.refreshCompletion();
      case 'delete': this.editor.deleteForward(); return this.refreshCompletion();
      case 'left': return key.ctrl || key.alt ? this.editor.moveWordLeft() : this.editor.moveLeft();
      case 'right': return key.ctrl || key.alt ? this.editor.moveWordRight() : this.editor.moveRight();
      case 'home': return this.editor.moveHome();
      case 'end': return this.editor.moveEnd();
      case 'up': return this.historyOrMove(-1);
      case 'down': return this.historyOrMove(1);
      case 'char': this.editor.insert(key.text); return this.refreshCompletion();
      default: break;
    }

    if (key.ctrl) {
      switch (key.name) {
        case 'a': return this.editor.moveHome();
        case 'e': return this.editor.moveEnd();
        case 'k': return this.editor.killToEnd();
        case 'u': return this.editor.killToStart();
        case 'w': this.editor.killWordLeft(); return this.refreshCompletion();
        case 'y': this.editor.yank(); return this.refreshCompletion();
        case 'p': return this.openPalette();
        case 'l': return this.clearScreen();
        case 'o': return this.expand();
        case 'v': {
          const text = readClipboardSync();
          if (text) {
            this.editor.insert(text);
            this.refreshCompletion();
            this.notice = 'pasted from clipboard';
          } else {
            this.notice = 'clipboard is empty';
          }
          this.scheduleDraw();
          return;
        }
        default: break;
      }
    }
    if (key.alt && (key.name === 'c' || key.name === 'w')) {
      const text = this.editor.getText();
      if (text) {
        writeClipboardSync(text);
        this.editor.killRing = text;
        this.notice = 'copied input to clipboard';
      } else {
        this.notice = 'input is empty (nothing to copy)';
      }
      this.scheduleDraw();
      return;
    }
    if (key.alt && key.name === 'v') {
      const text = readClipboardSync();
      if (text) {
        this.editor.insert(text);
        this.refreshCompletion();
        this.notice = 'pasted from clipboard';
      } else {
        this.notice = 'clipboard is empty';
      }
      this.scheduleDraw();
      return;
    }
    if (key.alt && key.name === 'b') return this.editor.moveWordLeft();
    if (key.alt && key.name === 'f') return this.editor.moveWordRight();
  }

  /**
   * Scroll the transcript viewport. Returns true when the key was ours.
   *
   * Only bound when a Stage is running: without one there is no viewport, the
   * terminal's own scrollback is the viewport, and stealing pageup from it
   * would be worse than useless.
   *
   * The choices, and why they are not opencode's:
   *
   *  * pageup/pagedown move a full viewport MINUS ONE ROW of overlap, which is
   *    what every pager does and what lets the eye carry across the jump.
   *    opencode calls height/2 a "page" and height/4 a "half page" — both are
   *    half of what their names claim, and there is no reason to inherit that.
   *  * ctrl+u / ctrl+d are NOT scroll keys. They are kill-to-start and
   *    delete/exit, tests/chatSurface.test.js asserts it, and a chat where the
   *    key that deletes your line also scrolls is a trap. Half-page is on the
   *    alt-modified pair instead.
   *  * home/end stay with the editor, so top/bottom take the shifted pageup and
   *    pagedown rather than fighting for them.
   */
  handleScrollKey(key) {
    const viewport = this.surface && this.surface.viewport;

    // A mouse report must be swallowed whether or not there is a viewport to
    // act on. The bytes are already consumed by the decoder; letting the event
    // fall through would put `mouse` or `wheel` into the switch below, where a
    // future case could act on it by accident — and, worse, a terminal that
    // kept reporting after a failed teardown would type into the user's line.
    if (key.name === 'mouse') {
      if (this.messageActionLoop && isMouseMotion(key.sequence)) {
        return handleMessageMouse(this, this.messageActionLoop, key);
      }
      if (handleScrollbarMouse(key, viewport, this.surface, this)) return true;
      if (!this.layer && this.messageActionLoop) return handleMessageMouse(this, this.messageActionLoop, key);
      return true;
    }
    if (key.name === 'wheel') {
      if (!viewport || !key.wheel) return true;
      if (this.renderer?.scrollCodePanel?.(key, this.surface)) return true;

      return handleViewportWheel(key, viewport, this.surface, this);
    }

    if (!viewport) return false;

    if (key.name === 'pageup') {
      if (key.shift) viewport.toTop(); else viewport.pageUp();
      return true;
    }
    if (key.name === 'pagedown') {
      // Shift+PgDn is the way back to following, and it is spelled out in the
      // affordance the surface draws while the view is held away.
      if (key.shift) viewport.toBottom(); else viewport.pageDown();
      return true;
    }
    if (key.shift && key.name === 'up') { viewport.lineUp(); return true; }
    if (key.shift && key.name === 'down') { viewport.lineDown(); return true; }
    if (key.alt && key.ctrl && key.name === 'u') { viewport.halfPageUp(); return true; }
    if (key.alt && key.ctrl && key.name === 'd') { viewport.halfPageDown(); return true; }

    // Jump by structure, not by rows. The transcript knows where each frame
    // starts, so `,`/`.` step through tool calls and the shifted `<`/`>` on the
    // same two physical keys step through exchanges — a bigger jump on the
    // bigger key press.
    //
    // These are alt-modified because a bare bracket is a character the user is
    // entitled to type; the plan's `[`/`]` could not be bound at all, and
    // alt+[ is worse than unbound — ESC [ IS the CSI introducer, so it is
    // indistinguishable from the start of an escape sequence.
    if (key.alt && key.name === ',') { viewport.jump(-1, ['step']); return true; }
    if (key.alt && key.name === '.') { viewport.jump(1, ['step']); return true; }
    // Exchanges are marked by the USER's message, not by the turn footer. Both
    // sit at almost the same seam — a footer is immediately followed by the next
    // question — so accepting either made the jump land twice two rows apart
    // instead of once per exchange.
    if (key.alt && key.name === '<') { viewport.jump(-1, ['user']); return true; }
    if (key.alt && key.name === '>') { viewport.jump(1, ['user']); return true; }

    if (key.alt && key.name === 'u') { this.offerUndo(); return true; }

    return false;
  }

  /**
   * OFFER the undo for the restore point you are looking at. Never perform it.
   *
   * The rail marks every restore point, which makes scrolling back a way of
   * finding somewhere to roll back TO — and that is worth nothing if reaching it
   * means remembering a command. This puts the command in the input line for
   * review; it does not run it, and it does not overwrite a message you were
   * part-way through typing.
   *
   * `/undo` is preview-by-default and needs `--apply` to write, so even the
   * accidental path here is a read. That is deliberate: a single keystroke may
   * not be able to overwrite a day's work.
   *
   * WHAT THIS IS NOT: undo for *exactly* that point. `/undo` takes a task, not a
   * checkpoint id, so there is no way to ask for "the state at this marker"
   * without changing restore semantics — which is not a terminal-UI change and
   * is not being smuggled into one. The notice says which step the marker is, so
   * the choice is at least informed.
   */
  offerUndo() {
    const surface = this.surface;
    if (!surface) return;
    const width = surface.viewport.width;
    const marks = surface.transcript.markers(width).filter((m) => m.kind === 'checkpoint');
    if (marks.length === 0) {
      this.notice = 'no restore points in this session yet';
      return;
    }

    const top = surface.viewport.scrollTop;
    const bottom = top + surface.viewport.height;
    const onScreen = marks.filter((m) => m.row >= top && m.row < bottom);
    const above = marks.filter((m) => m.row < top);
    const mark = onScreen.length ? onScreen[onScreen.length - 1] : (above.pop() || marks[0]);
    const meta = mark.meta || {};

    const where = meta.path ? shortenHome(meta.path) : 'files changed this task';
    const step = meta.step == null ? '' : ` at step ${meta.step}`;

    if (this.editor.isEmpty) {
      this.editor.setText('/undo');
      this.notice = `restore point${step} ${GLYPHS.dot} ${where} ${GLYPHS.dot} enter previews, --apply writes`;
    } else {
      // Their draft is theirs. Say what is there and leave the line alone.
      this.notice = `restore point${step} ${GLYPHS.dot} ${where} ${GLYPHS.dot} run /undo to preview`;
    }
  }

  handleCtrlC() {
    handlePromptCtrlC(
      this,
      () => [`${paint('warn', GLYPHS.cross)} ${dim('interrupted')}`],
      CTRL_C_WINDOW_MS
    );
  }

  handleEscape() {
    handlePromptEscape(
      this,
      () => [`${paint('warn', GLYPHS.cross)} ${dim('interrupted')}`]
    );
  }

  interrupt() {
    triggerTurnInterrupt(
      this,
      () => [`${paint('warn', GLYPHS.cross)} ${dim('interrupted')}`]
    );
  }

  /** Show the last tool output in full, above the prompt. */
  expand() {
    this.erase();
    this.onExpand();
    this.notice = '';
  }

  clearScreen() {
    // On the Stage, ctrl+L means what it means in a terminal: the screen goes
    // blank and your history is still behind you. Clearing the transcript alone
    // would destroy the session record, so the surface prints it through into
    // real scrollback first and then starts the band clean. It is also the
    // escape hatch for getting a transcript out of the band without exiting.
    if (this.surface) { this.surface.flushAndClear(); return; }

    this.erase();
    // The one clear Causyne may perform: the user pressed ctrl+L and asked for it.
    // UX-01 forbids clearing the terminal on the app's own initiative.
    this.out.write('\x1b[2J\x1b[H');
    this.drawnRows = 0;
    this.cursorRow = 0;
  }

  historyOrMove(direction) {
    // Inside a multi-line buffer the arrows move the cursor; history is only
    // reachable from the edge, which is what every shell does.
    if (direction === -1 && this.editor.line > 0) return this.editor.moveUp();
    if (direction === 1 && this.editor.line < this.editor.lines.length - 1) return this.editor.moveDown();

    const text = direction === -1
      ? this.history.previous(this.editor.getText())
      : this.history.next();
    if (text === null || text === undefined) return;
    this.editor.setText(text);
  }

  // -------------------------------------------------------------------------
  // Completion
  // -------------------------------------------------------------------------

  /** Dynamically re-target the prompt root and optional focused subproject. */
  setWorkingRoot(newRoot, focusDir = null) {
    this.root = newRoot;
    this.focusDir = focusDir;
    this.index = new FileIndex(newRoot);
    this.index.ensure();
  }

  cursorOffset() {
    const before = this.editor.lines
      .slice(0, this.editor.line)
      .reduce((total, line) => total + line.length + 1, 0);
    return before + this.editor.col;
  }

  openCompletion(force = false) {
    const text = this.editor.getText();
    const result = suggest(text, this.cursorOffset(), {
      root: this.root,
      index: this.index,
      focusDir: this.focusDir
    });
    if (!result) {
      if (force) this.notice = 'nothing to complete here';
      // Close a picker whose trigger has gone.
      this.completion = null;
      return;
    }
    this.completion = result;
    this.selected = 0;
  }

  /** Re-run completion after an edit; close it when the trigger is gone. */
  refreshCompletion() {
    if (!this.completion) {
      const text = this.editor.getText();
      const offset = this.cursorOffset();
      const opens = Boolean(detectTrigger(text, offset));
      if (opens) this.openCompletion(false);
      return;
    }
    this.openCompletion(false);
    if (this.completion) this.selected = Math.min(this.selected, this.completion.items.length - 1);
  }

  /**
   * Is the only suggestion the thing that is already typed?
   *
   * `/skill mine` offers exactly one completion — `mine` — which is what the
   * user has already written. Accepting it changes nothing, refreshCompletion()
   * immediately reopens the picker on the same text, and Enter becomes a key
   * that can never submit. The command was unreachable.
   *
   * openclaw solves this with shouldSubmitExactArgumentCompletion
   * (src/tui/commands.ts): when the sole completion equals the argument text,
   * submit instead of completing. Same rule here, extended to a whole command
   * so `/undo` submits on the first Enter rather than the second.
   *
   * Deliberately NOT applied to file completion: there, accepting a directory
   * that matches exactly is how you drill into it.
   */
  completionIsExact() {
    if (!this.completion || this.completion.items.length !== 1) return false;
    const [item] = this.completion.items;
    if (this.completion.kind === 'command-argument') return item.value === this.completion.query;
    if (this.completion.kind === 'command') return item.value === this.editor.getText();
    return false;
  }

  handleCompletionKey(key) {
    if (key.name === 'up') { this.moveSelection(-1); return true; }
    if (key.name === 'down') { this.moveSelection(1); return true; }
    if (key.name === 'mouse') {
      if (key.mouse && key.mouse.pressed && key.mouse.button === 0) {
        let item = null;
        if (this.pickerLayout && Number.isFinite(key.mouse.row)) {
          const stageHeight = this.surface?.stage?.height || process.stdout.rows || 24;
          const promptTop = Math.max(1, stageHeight - this.pickerLayout.totalPromptRows + 1);
          const pickerTop = promptTop + this.pickerLayout.pickerStart;
          const pickerBottom = pickerTop + this.pickerLayout.pickerCount - 1;

          if (key.mouse.row >= pickerTop && key.mouse.row <= pickerBottom) {
            const index = key.mouse.row - pickerTop;
            item = this.completion.items && this.completion.items[index];
          } else {
            // Click outside picker closes it
            this.completion = null;
            this.scheduleDraw();
            return true;
          }
        } else {
          item = this.completion.items && this.completion.items[this.selected];
        }

        if (item) {
          if (this.completion.kind === 'command') {
            this.editor.clear();
            this.completion = null;
            this.deliver(item.value);
            return true;
          }
          if (this.completion.kind === 'command-argument') {
            const cmd = this.completion.command;
            this.editor.clear();
            this.completion = null;
            this.deliver(`/${cmd} ${item.value}`);
            return true;
          }
          this.acceptCompletion();
          return true;
        }
      }
      return true;
    }
    if (key.name === 'enter' && !key.alt) {
      const item = this.completion.items && this.completion.items[this.selected];
      if (this.completion.kind === 'command' && item) {
        // Instant execution on single Enter for any slash command
        this.editor.clear();
        this.completion = null;
        this.deliver(item.value);
        return true;
      }
      if (this.completionIsExact()) {
        // Nothing left to complete. Close the picker and let the key through to
        // submit, rather than re-offering what is already on the line.
        this.completion = null;
        return false;
      }
      this.acceptCompletion();
      return true;
    }
    if (key.name === 'tab') { this.acceptCompletion(); return true; }
    if (key.name === 'escape') {
      this.completion = null;
      if (this.editor.getText().startsWith('/')) {
        this.editor.clear();
      }
      this.scheduleDraw();
      return true;
    }
    return false;
  }

  moveSelection(direction) {
    const count = this.completion.items.length;
    this.selected = (this.selected + direction + count) % count;
  }

  acceptCompletion() {
    const item = this.completion.items[this.selected];
    if (!item) { this.completion = null; return; }
    const applied = applyCompletion(
      this.editor.getText(), this.cursorOffset(), this.completion, item
    );
    this.editor.setText(applied.text);
    // setText parks the cursor at the end; put it back where the insert ended.
    this.setCursorOffset(applied.cursor);
    this.completion = null;
    this.refreshCompletion();
  }

  setCursorOffset(offset) {
    let remaining = offset;
    for (let index = 0; index < this.editor.lines.length; index++) {
      const length = this.editor.lines[index].length;
      if (remaining <= length) {
        this.editor.line = index;
        this.editor.col = remaining;
        return;
      }
      remaining -= length + 1;
    }
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  /**
   * Clamp every row so the terminal can never wrap one of them.
   *
   * THE invariant of the live region. erase() walks back up `cursorRow` rows and
   * clears with \x1b[J, and both numbers are LOGICAL row counts. A row wider
   * than the terminal occupies TWO physical rows, so the walk lands one row too
   * low and \x1b[J then clears from the middle of the block — leaving the rows
   * above it on screen as debris. That is the doubled hint row and the trail of
   * half-drawn glyphs in the reported screenshot.
   *
   * Measuring correctly is necessary but not sufficient: every glyph in GLYPHS is
   * East Asian Ambiguous (see text.js), so the measurement can legitimately
   * disagree with the terminal by a column. Cutting to width - 1 makes a wrap
   * impossible whatever the measurement says, and leaves the last column free so
   * a row that lands exactly on the edge cannot trip the terminal's deferred-wrap
   * state either.
   *
   * truncate() is escape-aware and closes an open SGR at the cut, so a clamped
   * row cannot leak colour into the row below.
   */
  clampRows(rows, width) {
    const limit = Math.max(1, width - 1);
    return rows.map((row) => (visibleWidth(row) <= limit ? row : truncate(row, limit, '')));
  }

  /** Remove everything this prompt drew, leaving the cursor where it started. */
  erase() {
    // Nothing of ours is on the terminal in stage mode — the band is painted by
    // a diff and the previous frame is a row array, not screen state. Walking
    // up and clearing here would erase rows the Stage owns and then paint over
    // them, which is the collision this method exists to prevent.
    if (this.surface) return;
    if (this.drawnRows === 0) {
      // Nothing of OURS is on screen — but the caret may still be sitting at a
      // non-zero column, because whoever wrote last left it there. Writing the
      // block from there puts its first row at that offset, which is how a
      // second `▏` appeared beside the first on the same row. Returning to
      // column 0 costs one byte and removes the whole class.
      this.out.write('\r');
      return;
    }
    if (this.cursorRow > 0) this.out.write(`\x1b[${this.cursorRow}A`);
    this.out.write('\r\x1b[J');
    this.drawnRows = 0;
    this.cursorRow = 0;
  }

  draw() {
    if (this.resizeTimer) return;
    if (!this.active) return;
    this.erase();

    const width = this.width();
    if (this.layer) return this.drawLayer(width);

    // The input is a BLOCK, not a line.
    //
    // It used to be a bare `▸ ` prefix, so the place the user types looked like
    // one more row of shell output among all the others. opencode gives its
    // prompt a left border in the agent's colour and a filled surface
    // (component/prompt/index.tsx:1353), which is what makes the input read as a
    // surface you are writing INTO. Every row of the block is inset by the same
    // gutter, so the caret column is a constant rather than a special case for
    // row 0 — which is also one fewer thing for erase() to get wrong.
    const inset = visibleWidth(GLYPHS.bar) + GUTTER;
    const inner = Math.max(8, width - inset);
    const layout = this.editor.render(inner, '');

    // Scroll the editor internally rather than growing without bound: keep a
    // window of MAX_PROMPT_ROWS that always contains the caret.
    const start = Math.max(0, Math.min(layout.cursorRow - MAX_PROMPT_ROWS + 1,
      layout.rows.length - MAX_PROMPT_ROWS));
    const top = Math.max(0, start);
    const window = layout.rows.slice(top, top + MAX_PROMPT_ROWS);
    const caretRow = layout.cursorRow - top;
    let body = window.slice();

    if (this.editor.isEmpty && !this.completion) {
      const idle = fitHints([`try "${this.example}"`, '/ commands', '@ files'], inner, 'ask anything');
      body = [dim(this.busy ? 'type to queue a message…' : idle)];
    }

    // The model line lives INSIDE the box, as its last row — except while a
    // completion picker is open. The suggestions belong to the text being
    // typed, and an ambient status row wedged between the two breaks that
    // connection for no gain; opencode floats its autocomplete directly against
    // the input for the same reason.
    //
    // A blank row separates the two. Without it the box is two lines of text
    // touching, which reads as a list; the reference leaves a row of space and
    // that is most of what makes it read as a surface you are typing into.
    const agent = this.completion ? null : this.agentRow(inner);
    if (agent) body = body.concat(['', agent]);

    // Air at the top of the surface and at the bottom, with the caret moved down
    // to match. The box is the thing the user is about to type into; it earns
    // the room.
    const rows = Number(this.out && this.out.rows);
    const roomy = !Number.isFinite(rows) || rows >= ROOMY_TERMINAL_ROWS;
    const padTop = (!Number.isFinite(rows) || rows >= CRAMPED_TERMINAL_ROWS) ? PROMPT_PAD_TOP : 0;
    const padBottom = roomy ? PROMPT_PAD_BOTTOM : 0;

    const padded = new Array(padTop).fill('')
      .concat(body, new Array(padBottom).fill(''));
    const boxRows = barBlock(padded, {
      width,
      role: this.busy ? 'accent' : 'user',
      filled: true,
      surface: 'surface',
      punctuate: true
    });

    const planRows = this.planRows(width);
    const pickerRows = this.completion ? this.pickerRows(width) : [];
    this.pickerLayout = this.completion ? {
      pickerStart: planRows.length + boxRows.length,
      pickerCount: pickerRows.length,
      totalPromptRows: 0
    } : null;
    const noticeRows = this.notice ? [dim(`  ${this.notice}`)] : [];

    // And a row of air between the box and the footer. The picker and a notice
    // belong to the input and stay welded to it — opencode floats its
    // autocomplete directly against the prompt for the same reason — so the gap
    // goes after them, immediately above the status row.
    const status = this.statusRow(width);
    const gap = status.length > 0 ? new Array(FOOTER_GAP).fill('') : [];

    const all = this.clampRows(
      planRows.concat(boxRows, pickerRows, noticeRows, gap, status), width
    );
    if (this.pickerLayout) this.pickerLayout.totalPromptRows = all.length;

    // Park the cursor where the user is typing, not at the end of the picker.
    const positioned = this.surface
      ? (this.surface.homeInfo ? centerRows(all, this.surface.width) : sessionRows(all, sessionMainWidth(this.surface.width)))
      : { rows: all, inset: 0 };
    this.present(positioned.rows, planRows.length + caretRow + padTop, layout.cursorCol + inset + positioned.inset);
  }

  /**
   * Put the composed block on screen.
   *
   * The two draw paths used to end with the same eleven lines of cursor
   * arithmetic; extracting it is what lets the Stage substitute itself for
   * stdout without either path knowing. In stage mode the rows are handed to
   * the surface, which stacks the transcript viewport above them and paints the
   * whole band in one diff — so drawnRows/cursorRow stay at zero, because
   * nothing of ours is on the terminal for erase() to walk back over.
   */
  present(all, caretRow, caretCol) {
    if (this.surface) {
      this.drawnRows = 0;
      this.cursorRow = 0;
      this.surface.present(all, { row: caretRow, col: caretCol,
        modal: Boolean(this.layer), inline: Boolean(this.layer && !isStartupDialog(this.surface)) });
      return;
    }

    this.out.write(all.join('\n'));
    this.drawnRows = all.length;

    const below = all.length - 1 - caretRow;
    if (below > 0) this.out.write(`\x1b[${below}A`);
    this.cursorRow = caretRow;
    this.out.write('\r');
    if (caretCol > 0) this.out.write(`\x1b[${caretCol}C`);
  }

  /**
   * Attach a Stage surface. From here on the prompt composes rows and this
   * decides where they land.
   */
  attachSurface(surface) {
    this.surface = surface || null;
    if (!surface) return;
    surface.onDirty = () => this.scheduleDraw();
  }

  /**
   * Put a finished block into the transcript.
   *
   * `produce` must be a pure function of width — a stage frame is re-rendered
   * on every resize, so anything it closes over must already be resolved. In
   * scrollback mode it is called once, immediately, and printed.
   */
  commit(kind, produce) {
    // clampRows() guarded the live region and nothing else, so a committed
    // block could still be exactly terminal-width, wrap, and desynchronise the
    // row count erase() walks back. The net belongs on both paths, not one.
    const clamped = (width) => this.clampRows(produce(width), width);
    if (this.surface) { this.surface.commit(kind, clamped); return; }
    this.erase();
    this.out.write(clamped(this.width()).join('\n') + '\n');
  }

  /** The live region while a dialog is up: the panel, then the status row. */
  drawLayer(width) {
    if (this.layer.messageActions && this.surface?.presentMessageActions) {
      const availableWidth = sessionMainWidth(this.surface.width);
      const panelWidth = dialogWidth(Math.max(8, availableWidth - 3), this.layer.width || 68);
      const panel = panelRows(this.layer, panelWidth, this.layer.preferredHeight());
      this.surface.presentMessageActions(panel, this.layer);
      return;
    }
    if (isStartupDialog(this.surface)) {
      const view = startupDialogView(this.layer, this.surface.width, this.surface.stage.maxHeight);
      return this.present(view.rows, view.caretRow, view.caretCol);
    }
    const inline = this.surface && !this.surface.homeInfo;
    const availableWidth = inline ? sessionMainWidth(this.surface.width) : width;
    const panelWidth = dialogWidth(availableWidth, this.layer.width || 64);
    const maxHeight = dialogHeight(this.surface?.stage?.maxHeight || this.out?.rows, this.layer.preferredHeight());
    const panel = panelRows(this.layer, panelWidth, maxHeight);
    const all = this.clampRows(panel.concat(this.statusRow(width)), width);

    // panelRows() called body(), which is where a layer publishes its cursor.
    const cursor = this.layer.cursor;
    const centered = this.surface ? centerRows(all, availableWidth) : { rows: all, inset: 0 };
    this.present(centered.rows, cursor ? 1 + cursor.y : 0,
      (cursor ? 2 + cursor.x : 0) + centered.inset);
  }

  pickerRows(width) {
    const rows = renderPicker(this.completion.items, this.selected, width);
    const labelWidth = Math.min(
      36,
      rows.reduce((max, row) => Math.max(max, visibleWidth(row.label)), 0)
    );

    const drawn = rows.map((row) => {
      const marker = row.selected ? paint('accent', GLYPHS.arrow) : ' ';
      const label = truncate(row.label, labelWidth, GLYPHS.ellipsis);
      const padded = label + ' '.repeat(Math.max(0, labelWidth - visibleWidth(label)));
      const name = row.selected ? bold(paint('ink', padded)) : paint('ink', padded);
      const description = row.description
        ? dim('  ' + truncate(row.description, Math.max(0, width - labelWidth - 8), GLYPHS.ellipsis))
        : '';
      return `  ${marker} ${name}${description}`;
    });

    // Count against everything that MATCHED, not against the capped array the
    // picker happens to hold. Reporting the capped figure told the user there
    // were 42 more entries when 107 were reachable by scrolling.
    const matched = this.completion.total || this.completion.items.length;
    const hidden = matched - drawn.length;
    if (hidden > 0) drawn.push(dim(`    ${GLYPHS.ellipsis} ${hidden} more`));
    return drawn;
  }
}

/**
 * Hint line for the session header — the keys that are not discoverable.
 *
 * FITTED to the terminal. The full list is 140 columns; printed unconditionally
 * it wrapped on any terminal narrower than that, which is how the very first
 * thing a user sees ended up broken across two rows mid-word. Fragments are
 * dropped from the right — least important first — rather than the line being
 * truncated, because a hint clipped mid-key is worse than a missing one.
 */
export function keyHints(width = terminalWidth()) {
  const parts = [
    'enter send', 'alt+enter newline', 'ctrl+p palette', '/ commands', '@ files',
    '↑ history', 'tab complete', 'esc interrupt', 'ctrl+o expand'
  ];
  const separator = `  ${GLYPHS.dot}  `;
  const kept = parts.slice();
  // Reserve a column, for the same reason every drawn row does: a line landing
  // exactly on the margin trips the terminal's deferred wrap.
  while (kept.length > 1 && visibleWidth(kept.join(separator)) > width - 1) kept.pop();
  return HAS_COLOR
    ? kept.map((part) => dim(part)).join(dim(separator))
    : kept.join(separator);
}

export { MAX_VISIBLE };
