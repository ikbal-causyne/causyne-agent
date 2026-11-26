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
import { TerminalInputFramer, INPUT_PREFIX_TIMEOUT_MS, shouldTreatAsAtomicPaste } from './terminalInputFramer.js';
import { LineEditor } from './lineEditor.js';
import { PromptHistory } from './history.js';
import { FileIndex, suggest, applyCompletion, detectTrigger, renderPicker, MAX_VISIBLE } from './completion.js';
import { removeInlineSlashToken, isInlineSkillInvocation } from './inlineSlash.js';
import { paint, dim, bold, GLYPHS, terminalWidth, HAS_COLOR } from './theme.js';
import { barBlock, GUTTER } from './block.js';
import { composerGeometry } from './composerGeometry.js';
import { visibleWidth, truncate, wrapBlock, shortenHome, safeDisplay } from './text.js';
import { pickExample, fitHints } from './banner.js';
import { panelRows } from './overlay.js';
import { renderUsageCardRows, renderStatusCardRows, collectUsageCardData } from './usageCard.js';
import { buildStatusText } from '../reporting.js';
import { commandPalette, skillPicker, ApprovalLayer, DecisionLayer, ConfirmLayer, HomeLayer, TextLayer } from './dialogs.js';
import { describeTool } from './toolDisplay.js';
import { writeClipboardSync } from './clipboardSync.js';
import { pasteIntoChatbox } from './chatboxClipboard.js';
import { handleViewportWheel, handleScrollbarMouse } from './scrollInteraction.js';
import { centerRows, sessionRows, dialogWidth, dialogHeight } from './layout.js';
import { settleStageResize } from './resizeRecovery.js';
import { sidebarVisible, sessionMainWidth } from './sessionSidebar.js';
import { isStartupDialog, startupDialogView } from './homeView.js';
import { handleMessageMouse, handleMessageActionMenuMouse, isMouseMotion } from './messageInteraction.js';
import { handleTurnRailMouse } from './turnRail.js';
import { runWithStageWrite } from './consoleGuard.js';
import { resetTurnInterruptState, shouldAcceptStatusUpdate, triggerTurnInterrupt, handlePromptCtrlC, handlePromptEscape } from './composerControls.js';
const CTRL_C_WINDOW_MS = 2000;
// Rows the editor may occupy before it starts scrolling internally.
const MAX_PROMPT_ROWS = 8;
// How long to wait for a resize gesture to settle before repainting.
const RESIZE_SETTLE_MS = 60;
const PROMPT_PAD_TOP = 1;
const PROMPT_PAD_BOTTOM = 1;
const FOOTER_GAP = 1;
const ROOMY_TERMINAL_ROWS = 20;
const CRAMPED_TERMINAL_ROWS = 18;
/** Can this process own the keyboard? */
export function isInteractive() {
    if (process.env.CAUSYNE_SIMPLE_INPUT === '1')
        return false;
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
export class ChatPrompt {
    out;
    input;
    root;
    focusDir;
    onInterrupt;
    surface;
    onExit;
    onExpand;
    onOpenMode;
    onCycleMode;
    onOpenModel;
    onOpenVariant;
    onOpenVariantList;
    messageActionLoop;
    getMode;
    editor;
    history;
    index;
    _unsubscribeFileIndex;
    decoder;
    inputFramer;
    inputFrameTimer;
    decoderRecoveryTimer;
    busy;
    active;
    exitHook;
    drawnRows;
    usageCard;
    usageCardLoading;
    statusCard;
    statusCardUsage;
    infoPanelVersion;
    usageRefreshPending;
    cursorRow;
    renderer;
    statusMessage;
    tick;
    tickTimer;
    example;
    commands;
    isCommand;
    layer;
    queue;
    waiter;
    currentSubmissionAttachments;
    completion;
    selected;
    lastCtrlC;
    interruptedTurn;
    notice;
    redrawScheduled;
    resizeTimer;
    suspendedSurface;
    pendingAttachments;
    pickerLayout;
    constructor(options = {}) {
        const opts = options && typeof options === 'object' ? options : {};
        this.out = opts.out || process.stdout;
        this.input = opts.input || process.stdin;
        this.root = opts.root || process.cwd();
        this.focusDir = opts.focusDir || null;
        this.onInterrupt = opts.onInterrupt || (() => { });
        this.surface = opts.surface || null;
        this.onExit = opts.onExit || (() => process.exit(0));
        this.onExpand = opts.onExpand || (() => { });
        this.onOpenMode = opts.onOpenMode || null;
        this.onCycleMode = opts.onCycleMode || null;
        this.onOpenModel = opts.onOpenModel || null;
        this.onOpenVariant = opts.onOpenVariant || null;
        this.onOpenVariantList = opts.onOpenVariantList || null;
        this.messageActionLoop = opts.messageActionLoop || null;
        this.getMode = opts.getMode || (() => 'B');
        this.editor = new LineEditor();
        this.history = opts.history || new PromptHistory();
        this.index = new FileIndex(this.root);
        this._unsubscribeFileIndex = null;
        this.bindFileIndex(this.index);
        this.decoder = new KeyDecoder();
        this.inputFramer = new TerminalInputFramer();
        this.inputFrameTimer = null;
        this.decoderRecoveryTimer = null;
        this.busy = false;
        this.active = false;
        this.exitHook = null;
        this.drawnRows = 0;
        this.usageCard = null;
        this.usageCardLoading = false;
        this.statusCard = null;
        this.statusCardUsage = null;
        this.infoPanelVersion = 0;
        this.usageRefreshPending = false;
        this.cursorRow = 0;
        this.renderer = opts.renderer || null;
        this.statusMessage = '';
        this.tick = 0;
        this.tickTimer = null;
        this.example = pickExample();
        this.commands = opts.commands || [];
        this.isCommand = typeof opts.isCommand === 'function' ? opts.isCommand : () => false;
        this.layer = null;
        this.queue = [];
        this.waiter = null;
        this.currentSubmissionAttachments = null;
        this.completion = null;
        this.selected = 0;
        this.lastCtrlC = 0;
        this.interruptedTurn = false;
        this.notice = '';
        this.redrawScheduled = false;
        this.resizeTimer = null;
        this.suspendedSurface = null;
        this.pendingAttachments = [];
        this.pickerLayout = null;
    }
    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------
    writeControl(sequence) {
        if (!sequence)
            return;
        runWithStageWrite(() => {
            this.out.write(sequence);
        });
    }
    start() {
        if (this.active)
            return;
        this.active = true;
        this.inputFramer.clear();
        this.input.setRawMode(true);
        this.input.resume();
        this.input.on('data', this.handleData);
        this.writeControl(bracketedPaste(true));
        this.exitHook = () => {
            try {
                this.writeControl(bracketedPaste(false));
            }
            catch { /* terminal already closed */ }
            try {
                this.input.setRawMode(false);
            }
            catch { /* stdin already closed */ }
        };
        process.once('exit', this.exitHook);
        if (typeof this.out.on === 'function')
            this.out.on('resize', this.handleResize);
    }
    stop() {
        if (!this.active) {
            if (this.waiter) {
                const resolve = this.waiter;
                this.waiter = null;
                resolve(null);
            }
            return;
        }
        this.active = false;
        if (this.layer) {
            const layer = this.layer;
            this.layer = null;
            if (typeof layer.answer === 'function')
                layer.answer(false);
        }
        if (this.waiter) {
            const resolve = this.waiter;
            this.waiter = null;
            resolve(null);
        }
        if (typeof this._unsubscribeFileIndex === 'function') {
            this._unsubscribeFileIndex();
            this._unsubscribeFileIndex = null;
        }
        this.index?.dispose();
        this.stopTick();
        if (this.inputFrameTimer) {
            clearTimeout(this.inputFrameTimer);
            this.inputFrameTimer = null;
        }
        if (this.decoderRecoveryTimer) {
            clearTimeout(this.decoderRecoveryTimer);
            this.decoderRecoveryTimer = null;
        }
        this.inputFramer.clear();
        this.decoder.pending = Buffer.alloc(0);
        if (this.resizeTimer) {
            clearTimeout(this.resizeTimer);
            this.resizeTimer = null;
        }
        this.erase();
        if (this.surface)
            this.surface.close();
        this.writeControl(bracketedPaste(false));
        if (typeof this.out.removeListener === 'function')
            this.out.removeListener('resize', this.handleResize);
        this.input.off('data', this.handleData);
        try {
            this.input.setRawMode(false);
        }
        catch { /* already closed */ }
        this.input.pause();
        if (this.exitHook) {
            process.removeListener('exit', this.exitHook);
            this.exitHook = null;
        }
    }
    handleResize = () => {
        if (!this.resizeTimer)
            this.erase();
        if (this.resizeTimer)
            clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(() => {
            this.resizeTimer = null;
            this.drawnRows = 0;
            this.cursorRow = 0;
            const settled = settleStageResize(this.surface, this.suspendedSurface);
            this.surface = settled.current;
            this.suspendedSurface = settled.suspended;
            if (settled.restored)
                this.attachSurface(settled.current);
            this.draw();
        }, RESIZE_SETTLE_MS);
        if (this.resizeTimer.unref)
            this.resizeTimer.unref();
    };
    handleData = (chunk) => {
        const frames = this.inputFramer.push(chunk);
        for (const frame of frames)
            this.handleFramedData(frame);
        if (this.inputFrameTimer) {
            clearTimeout(this.inputFrameTimer);
            this.inputFrameTimer = null;
        }
        if (this.inputFramer.hasPending) {
            this.inputFrameTimer = setTimeout(() => {
                this.inputFrameTimer = null;
                for (const frame of this.inputFramer.flush())
                    this.handleFramedData(frame);
            }, INPUT_PREFIX_TIMEOUT_MS);
            this.inputFrameTimer.unref?.();
        }
    };
    flushCharBatch(charBatch) {
        if (!charBatch)
            return '';
        this.prepareKeyboardState(true);
        this.editor.insert(charBatch);
        if (charBatch.length < 60 && !charBatch.includes('\n')) {
            this.refreshCompletion();
        }
        else {
            this.completion = null;
        }
        return '';
    }
    prepareKeyboardState(clearNotice) {
        if (clearNotice && this.notice && !this.layer)
            this.notice = '';
        if (this.surface && typeof this.surface.captureMouse === 'function') {
            if (this.surface.captureMouse() && typeof this.notice === 'string' && this.notice.startsWith('top of this view')) {
                this.notice = '';
            }
        }
        if (this.surface) {
            this.surface.turnRailHoverSuppressed = false;
            if (this.surface.hoveredTurnIndex !== null && this.surface.hoveredTurnIndex !== undefined) {
                this.surface.hoveredTurnIndex = null;
                this.surface.hoveredTurnAnchorY = null;
                this.scheduleDraw();
            }
        }
    }
    handleFramedData = (chunk) => {
        let motionOnly = true;
        const str = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
        if (!this.layer && shouldTreatAsAtomicPaste(chunk, this.decoder)) {
            try {
                this.handleKey({ name: 'paste', text: str, sequence: '' });
            }
            catch (error) {
                this.notice = `paste failed: ${this.sanitizeSingleLine(error instanceof Error ? error.message : String(error))}`;
                this.scheduleDraw();
            }
            this.draw();
            return;
        }
        const keys = this.decoder.decode(chunk);
        if (this.decoderRecoveryTimer)
            clearTimeout(this.decoderRecoveryTimer);
        this.decoderRecoveryTimer = null;
        if (!this.decoder.inPaste && this.decoder.pending.length > 0) {
            this.decoderRecoveryTimer = setTimeout(() => {
                this.decoderRecoveryTimer = null;
                const recovered = this.decoder.drainIncomplete();
                for (const event of recovered)
                    this.handleKey(event);
                if (recovered.length)
                    this.scheduleDraw();
            }, 180);
            this.decoderRecoveryTimer.unref?.();
        }
        let charBatch = '';
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            if (!key)
                continue;
            if (!this.layer && key.name === 'char' && typeof key.text === 'string' && !key.alt && !key.ctrl) {
                charBatch += key.text;
                motionOnly = false;
                continue;
            }
            if (charBatch.length > 0) {
                charBatch = this.flushCharBatch(charBatch);
            }
            if (key.name !== 'mouse' || !isMouseMotion(key.sequence))
                motionOnly = false;
            try {
                this.handleKey(key);
            }
            catch (e) {
                this.notice = `input error: ${this.sanitizeSingleLine(e instanceof Error ? e.message : String(e))}`;
                this.scheduleDraw();
            }
        }
        if (charBatch.length > 0) {
            charBatch = this.flushCharBatch(charBatch);
        }
        if (!motionOnly)
            this.draw();
    };
    attach(renderer) {
        renderer.onBeforeWrite = () => this.erase();
        renderer.onAfterWrite = () => this.scheduleDraw();
        this.renderer = renderer;
        if (this.surface)
            this.surface.sidebarStatus = renderer.status;
        renderer.quietStatus = true;
        renderer.onStatusChange = (message) => {
            if (!shouldAcceptStatusUpdate(this))
                return;
            this.statusMessage = message;
            this.scheduleDraw();
        };
        renderer.onPlanChange = (plan) => {
            if (this.surface)
                this.surface.sidebarPlan = plan;
            this.scheduleDraw();
            return this.surface && sidebarVisible(this.surface.width, false, this.surface.env) ? 'sidebar' : undefined;
        };
    }
    statusRow(width) {
        if (!this.renderer || !this.renderer.status)
            return [];
        const status = this.renderer.status;
        if (!this.busy) {
            return [status.renderIdle({
                    width: Math.max(10, width),
                    hint: this.commands.length > 0 ? 'ctrl+p commands' : ''
                })];
        }
        const frame = GLYPHS.spinner[this.tick % GLYPHS.spinner.length] ?? '*';
        const since = this.renderer.turnStartedAt;
        return [status.render({
                message: this.statusMessage || 'working',
                elapsedMs: since ? Date.now() - since : 0,
                steps: this.renderer.stepCount || 0,
                width: Math.max(10, width - 1),
                spinnerFrame: frame,
                tick: this.tick
            })];
    }
    agentRow(width) {
        const status = this.renderer && this.renderer.status;
        if (!status)
            return null;
        const mode = `${this.busy ? 'Working' : 'Build'} ${this.getMode()}`;
        const parts = [bold(paint('accent', mode))];
        if (status.model)
            parts.push(bold(paint('ink', status.model)));
        if (status.variant)
            parts.push(paint('accent', `[${status.variant}]`));
        const line = parts.join(dim(`  ${GLYPHS.dot}  `));
        const trailing = [status.provider, status.tier].filter(Boolean).join(' ');
        const base = trailing ? `${line}  ${dim(trailing)}` : line;
        const details = [];
        if (this.queue.length)
            details.push(`${this.queue.length} queued`);
        if (this.editor.lines.length > 1)
            details.push(`${this.editor.lines.length} lines`);
        const extra = details.length ? dim(`  ${GLYPHS.dot}  ${details.join(' · ')}`) : '';
        const withMeta = visibleWidth(base) + visibleWidth(extra) <= width ? base + extra : base;
        const hints = dim('  Ctrl+G/⇧Tab mode · Alt+M model · Ctrl+T variant');
        const full = visibleWidth(withMeta) + visibleWidth(hints) <= width ? withMeta + hints : withMeta;
        return visibleWidth(full) > width ? truncate(full, width, GLYPHS.ellipsis) : full;
    }
    planRows(width) {
        if (this.surface && sidebarVisible(this.surface.width, false, this.surface.env))
            return [];
        const plan = this.renderer && Array.isArray(this.renderer.latestPlan) ? this.renderer.latestPlan : [];
        if (plan.length === 0)
            return [];
        const completed = plan.filter(item => item.status === 'completed').length;
        const stageMax = this.surface?.stage?.maxHeight || this.out?.rows || 24;
        if (stageMax < 22) {
            const activeStep = plan.find(item => item.status === 'in_progress') || plan.find(item => item.status !== 'completed') || plan[0];
            const stepText = activeStep ? (activeStep.text || activeStep.step || '') : '';
            const summary = `${paint('accent', GLYPHS.skill || '✦')} ${bold('plan')} ${dim(`(${completed}/${plan.length})`)} ${dim('·')} ${truncate(safeDisplay(stepText), Math.max(8, width - 24), GLYPHS.ellipsis)}`;
            return [summary, ''];
        }
        const rows = [`${bold(paint('accent', 'implementation plan'))}  ${dim(`${completed}/${plan.length}`)}`];
        const limit = Math.min(plan.length, 5);
        const active = plan.findIndex(item => item.status === 'in_progress');
        const pending = plan.findIndex(item => item.status !== 'completed');
        const focus = active >= 0 ? active : pending >= 0 ? pending : plan.length - 1;
        const start = Math.max(0, Math.min(focus - 1, plan.length - limit));
        if (start > 0)
            rows.push(`  ${dim(`${GLYPHS.ellipsis} ${start} earlier`)}`);
        for (const item of plan.slice(start, start + limit)) {
            const mark = item.status === 'completed'
                ? paint('success', GLYPHS.check)
                : item.status === 'in_progress'
                    ? paint('accent', GLYPHS.arrow)
                    : paint('muted', GLYPHS.dot);
            rows.push(`  ${mark} ${truncate(safeDisplay(item.text || item.step || ''), Math.max(8, width - 5), GLYPHS.ellipsis)}`);
        }
        const remaining = plan.length - start - limit;
        if (remaining > 0)
            rows.push(`  ${dim(`${GLYPHS.ellipsis} ${remaining} later`)}`);
        rows.push('');
        return rows;
    }
    startTick() {
        if (this.tickTimer)
            return;
        this.tickTimer = setInterval(() => {
            this.tick++;
            if (this.busy)
                this.scheduleDraw();
            if (this.busy && (this.usageCard || this.statusCard !== null) && this.tick % 32 === 0) {
                this.refreshPinnedPanels();
            }
        }, 125);
        if (this.tickTimer.unref)
            this.tickTimer.unref();
    }
    stopTick() {
        if (!this.tickTimer)
            return;
        clearInterval(this.tickTimer);
        this.tickTimer = null;
    }
    openLayer(layer) {
        this.closeLayer();
        this.layer = layer;
        if (this.surface?.stage)
            this.surface.stage.invalidate();
        this.draw();
        return layer;
    }
    closeLayer() {
        const layer = this.layer;
        if (!layer)
            return;
        this.layer = null;
        if (typeof layer.answer === 'function')
            layer.answer(false);
        if (this.surface?.stage)
            this.surface.stage.invalidate();
        this.draw();
    }
    openPalette() {
        if (this.commands.length === 0) {
            this.notice = 'no commands available';
            return;
        }
        this.openLayer(commandPalette(this.commands, (command) => {
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
    setText(text) {
        this.editor.setText(String(text == null ? '' : text));
        this.completion = null;
        this.scheduleDraw();
    }
    updateModel(provider, model, variant) {
        const nextProvider = provider ? String(provider) : '';
        const nextModel = model ? String(model) : '';
        const sessionUpdate = {
            provider: nextProvider,
            model: nextModel
        };
        if (variant !== undefined) {
            sessionUpdate.variant = variant ? String(variant) : '';
        }
        if (this.renderer && this.renderer.status) {
            this.renderer.status.setSession(sessionUpdate);
        }
        if (this.surface && typeof this.surface.setSessionInfo === 'function') {
            this.surface.setSessionInfo(sessionUpdate);
        }
        this.scheduleDraw();
    }
    browseSkills(skills, onOpen) {
        if (!Array.isArray(skills) || skills.length === 0) {
            this.notice = 'no skills are compiled into this build';
            this.scheduleDraw();
            return;
        }
        this.openLayer(skillPicker(skills, (skill) => {
            this.layer = null;
            if (onOpen)
                onOpen(skill);
        }));
    }
    showText(title, text, options = {}) {
        const opts = options && typeof options === 'object' ? options : {};
        const panelWidth = dialogWidth(this.width(), opts.width || 76);
        const contentWidth = Math.max(12, panelWidth - 4);
        let lines = wrapBlock(safeDisplay(String(text == null ? '' : text)), contentWidth, { hang: 0 });
        if (lines.length > 0 && (lines[0] ?? '').trim().toLowerCase() === String(title || '').trim().toLowerCase()) {
            lines = lines.slice(1);
            if (lines.length > 0 && /^[-─═_]+$/.test((lines[0] ?? '').trim())) {
                lines = lines.slice(1);
            }
        }
        return this.openLayer(new TextLayer({
            title: String(title || 'Details'),
            lines: opts.danger ? lines.map((line) => paint('danger', line)) : lines,
            width: panelWidth,
            height: opts.height || 20
        }));
    }
    async toggleUsageCard(loop = null) {
        if (this.usageCard || this.usageCardLoading) {
            this.closeUsageCard();
            return false;
        }
        const version = ++this.infoPanelVersion;
        this.statusCard = null;
        this.statusCardUsage = null;
        this.usageCardLoading = true;
        try {
            const data = await collectUsageCardData(loop || this.messageActionLoop);
            if (version !== this.infoPanelVersion || !this.usageCardLoading)
                return false;
            this.usageCard = data;
            this.usageCardLoading = false;
            this.scheduleDraw();
            return true;
        }
        catch (error) {
            if (version === this.infoPanelVersion) {
                this.usageCardLoading = false;
                this.notice = this.sanitizeSingleLine(error instanceof Error ? error.message : String(error));
                this.scheduleDraw();
            }
            return false;
        }
    }
    showUsageCard(loop = null) {
        return this.toggleUsageCard(loop);
    }
    closeUsageCard() {
        if (!this.usageCard && !this.usageCardLoading)
            return false;
        ++this.infoPanelVersion;
        this.usageCard = null;
        this.usageCardLoading = false;
        this.scheduleDraw();
        return true;
    }
    async refreshUsageCard(loop = null) {
        if (!this.usageCard || this.usageRefreshPending)
            return false;
        const version = this.infoPanelVersion;
        this.usageRefreshPending = true;
        try {
            const data = await collectUsageCardData(loop || this.messageActionLoop);
            if (version !== this.infoPanelVersion || !this.usageCard)
                return false;
            this.usageCard = data;
            this.scheduleDraw();
            return true;
        }
        catch {
            return false;
        }
        finally {
            this.usageRefreshPending = false;
        }
    }
    toggleStatusCard(loop = null) {
        if (this.statusCard !== null) {
            this.closeStatusCard();
            return false;
        }
        const targetLoop = loop || this.messageActionLoop;
        ++this.infoPanelVersion;
        this.usageCard = null;
        this.usageCardLoading = false;
        this.statusCardUsage = null;
        this.statusCard = buildStatusText({ loop: targetLoop });
        this.scheduleDraw();
        void this.refreshStatusCardMeta(targetLoop);
        return true;
    }
    closeStatusCard() {
        if (this.statusCard === null)
            return false;
        ++this.infoPanelVersion;
        this.statusCard = null;
        this.statusCardUsage = null;
        this.scheduleDraw();
        return true;
    }
    async refreshStatusCardMeta(loop = null) {
        if (this.statusCard === null)
            return false;
        const version = this.infoPanelVersion;
        try {
            const data = await collectUsageCardData(loop || this.messageActionLoop);
            if (version !== this.infoPanelVersion || this.statusCard === null)
                return false;
            this.statusCardUsage = data;
            this.scheduleDraw();
            return true;
        }
        catch {
            return false;
        }
    }
    refreshPinnedPanels(loop = null) {
        const targetLoop = loop || this.messageActionLoop;
        if (this.usageCard)
            void this.refreshUsageCard(targetLoop);
        if (this.statusCard !== null) {
            this.statusCard = buildStatusText({ loop: targetLoop });
            this.scheduleDraw();
            void this.refreshStatusCardMeta(targetLoop);
        }
    }
    statusCardRows(width) {
        if (this.statusCard === null)
            return [];
        return renderStatusCardRows(this.statusCard, this.statusCardUsage, width);
    }
    approve(request = {}) {
        return new Promise((resolve) => {
            const { verb } = describeTool(request.tool, request.args || {});
            this.openLayer(new ApprovalLayer({
                request,
                verb,
                onAnswer: (approved, scope) => resolve({ approved, scope: scope || (approved ? 'once' : 'reject') })
            }));
        });
    }
    decide(request = {}) {
        return new Promise((resolve) => {
            this.openLayer(new DecisionLayer({ request, onAnswer: resolve }));
        });
    }
    confirm(message, options = {}) {
        const opts = options && typeof options === 'object' ? options : {};
        return new Promise((resolve) => {
            let settled = false;
            const settle = (answer) => { if (!settled) {
                settled = true;
                resolve(Boolean(answer));
            } };
            const layer = new ConfirmLayer({
                message,
                defaultAnswer: opts.defaultAnswer === true,
                onAnswer: settle
            });
            this.openLayer(layer);
        });
    }
    width() {
        if (this.surface && typeof this.surface.composeWidth === 'function') {
            const asked = this.surface.composeWidth();
            if (Number.isFinite(asked) && asked > 0)
                return Math.max(20, asked);
        }
        const columns = this.out && this.out.columns;
        return Number.isFinite(columns) && columns > 0
            ? Math.max(20, columns)
            : terminalWidth();
    }
    scheduleDraw() {
        if (this.redrawScheduled || !this.active)
            return;
        this.redrawScheduled = true;
        setImmediate(() => {
            this.redrawScheduled = false;
            this.draw();
        });
    }
    renderSubmittedUserMessage(text) {
        if (this.surface?.homeInfo)
            this.surface.leaveHome();
        if (this.renderer?.renderUserMessage)
            this.renderer.renderUserMessage(text);
        else
            this.commit('user', (width) => {
                const blockWidth = Math.max(8, width);
                return barBlock(wrapBlock(safeDisplay(text), Math.max(8, blockWidth - visibleWidth(GLYPHS.barHeavy || GLYPHS.bar) - GUTTER), { hang: 0 }), { width: blockWidth, role: 'user', filled: true, surface: 'surfaceHi' });
            });
    }
    restoreUnconsumedAttachments() {
        if (Array.isArray(this.currentSubmissionAttachments) && this.currentSubmissionAttachments.length) {
            this.pendingAttachments = this.currentSubmissionAttachments.concat(this.pendingAttachments);
        }
        this.currentSubmissionAttachments = null;
    }
    takeSubmissionAttachments() {
        const attachments = Array.isArray(this.pendingAttachments) ? this.pendingAttachments : [];
        this.pendingAttachments = [];
        return attachments;
    }
    enqueueSubmission(text, { rendered = false } = {}) {
        if (!Array.isArray(this.queue))
            this.queue = [];
        if (this.isCommand(text)) {
            this.queue.push(text);
        }
        else {
            this.queue.push({ kind: 'chat-submission', text, attachments: this.takeSubmissionAttachments(), rendered });
        }
    }
    read() {
        this.restoreUnconsumedAttachments();
        if (this.queue.length > 0) {
            const entry = this.queue.shift();
            const submission = Boolean(entry && typeof entry === 'object' && entry.kind === 'chat-submission');
            const text = submission ? entry.text : entry;
            if (submission)
                this.currentSubmissionAttachments = entry.attachments;
            if (typeof text === 'string' && !this.isCommand(text) && !(submission && entry.rendered)) {
                this.renderSubmittedUserMessage(text);
            }
            this.scheduleDraw();
            return Promise.resolve(text);
        }
        return new Promise((resolve) => { this.waiter = resolve; });
    }
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
    consumeAttachments() {
        if (this.currentSubmissionAttachments !== null) {
            const attachments = this.currentSubmissionAttachments;
            this.currentSubmissionAttachments = null;
            return Array.isArray(attachments) ? attachments : [];
        }
        return this.takeSubmissionAttachments();
    }
    pasteClipboard() {
        pasteIntoChatbox(this);
    }
    setBusy(busy) {
        this.busy = busy;
        resetTurnInterruptState(this, busy);
        if (busy)
            this.startTick();
        else
            this.stopTick();
        if (!busy && this.usageCard)
            void this.refreshUsageCard();
        if (this.statusCard !== null) {
            this.statusCard = buildStatusText({ loop: this.messageActionLoop });
            if (!busy)
                void this.refreshStatusCardMeta(this.messageActionLoop);
        }
        if (this.surface?.stage)
            this.surface.stage.invalidate();
        this.draw();
    }
    submit() {
        const text = this.editor.getText();
        if (!text.trim())
            return;
        if (!Array.isArray(this.queue))
            this.queue = [];
        if ((this.busy || !this.waiter) && this.queue.length >= 32
            && !/^\/(?:stop|interrupt)$/i.test(text.trim())) {
            this.notice = '32 queued messages: wait for a turn to complete before adding another';
            this.scheduleDraw();
            return;
        }
        this.erase();
        this.history.add(text);
        this.editor.clear();
        this.completion = null;
        const trimmedLower = text.trim().toLowerCase();
        if ((trimmedLower === '/usage' || trimmedLower === '/cost')
            && typeof this.toggleUsageCard === 'function') {
            void this.toggleUsageCard();
            return;
        }
        if (trimmedLower === '/status' && typeof this.toggleStatusCard === 'function') {
            this.toggleStatusCard();
            return;
        }
        if (trimmedLower === '/observer' || trimmedLower === '/observer status') {
            import('./observerPicker.js').then(({ runInteractiveObserverPicker }) => {
                void runInteractiveObserverPicker(this);
            }).catch((err) => {
                this.notice = this.sanitizeSingleLine(err instanceof Error ? err.message : String(err));
                this.scheduleDraw();
            });
            return;
        }
        const commandToken = (trimmedLower.split(/\s+/, 1)[0] ?? '').toLowerCase();
        const isControlCommand = this.isCommand(text) && new Set([
            '/stop', '/interrupt', '/new', '/model', '/models',
            '/variant', '/effort', '/reasoning', '/cortex',
            '/gui', '/web', '/studio',
            '/session', '/sessions', '/continuum', '/clear'
        ]).has(commandToken);
        if ((trimmedLower === '/stop' || trimmedLower === '/interrupt') && this.busy) {
            this.interrupt();
            this.notice = 'Interrupted';
            this.scheduleDraw();
            return;
        }
        if (isControlCommand && this.busy) {
            this.interrupt();
        }
        if (this.busy) {
            if (this.isCommand(text)) {
                this.notice = `Command ${this.sanitizeSingleLine(text)} queued — will execute when current turn completes`;
            }
            else {
                this.notice = `queued (${this.queue.length + 1}) — sends when this turn ends`;
            }
            this.enqueueSubmission(text);
            this.scheduleDraw();
            return;
        }
        if (this.isCommand(text)) {
            const settle = this.waiter;
            this.waiter = null;
            if (settle)
                settle(text);
            else {
                this.enqueueSubmission(text);
                this.notice = `queued (${this.queue.length}) — sends when ready`;
                this.scheduleDraw?.();
            }
            return;
        }
        const resolve = this.waiter;
        this.waiter = null;
        if (resolve) {
            this.restoreUnconsumedAttachments();
            this.currentSubmissionAttachments = this.takeSubmissionAttachments();
            this.renderSubmittedUserMessage(text);
            resolve(text);
        }
        else {
            this.renderSubmittedUserMessage(text);
            this.enqueueSubmission(text, { rendered: true });
            this.notice = `queued (${this.queue.length}) — sends when ready`;
            this.scheduleDraw?.();
        }
    }
    // -------------------------------------------------------------------------
    // Keys
    // -------------------------------------------------------------------------
    handleKey(key) {
        const clearNotice = key.name === 'char' || key.name === 'paste' || key.name === 'backspace' || key.name === 'delete';
        if (clearNotice && this.notice && !this.layer) {
            this.notice = '';
        }
        if (key.name !== 'wheel' && key.name !== 'mouse') {
            this.prepareKeyboardState(false);
        }
        if (key.ctrl && key.name === 'c') {
            if (this.layer) {
                this.closeLayer();
                return;
            }
            if (this.editor.hasSelection) {
                const text = this.editor.getSelectedText();
                try {
                    writeClipboardSync(text);
                }
                catch { /* clipboard unavailable */ }
                this.editor.killRing = text;
                this.notice = `copied selection (${text.length} chars) to clipboard`;
                this.scheduleDraw();
                return;
            }
            return this.handleCtrlC();
        }
        if (key.ctrl && key.name === 'd' && this.editor.isEmpty)
            return this.onExit();
        if (this.layer) {
            const previousSelection = this.layer.messageActions ? this.layer.list?.selected : null;
            const action = key.name === 'mouse' && this.layer.messageActions
                ? handleMessageActionMenuMouse(this.layer, key)
                : this.layer.key(key);
            if (this.layer?.messageActions && isMouseMotion(key.sequence)
                && previousSelection !== this.layer.list?.selected)
                this.scheduleDraw();
            if (action === 'close') {
                this.closeLayer();
                return;
            }
            if (action === 'dismiss')
                this.closeLayer();
            else if (action !== 'passthrough')
                return;
        }
        if (key.name === 'paste-too-large') {
            this.notice = 'Paste exceeds 2 MiB; input unchanged. Attach a file or reduce the selection.';
            this.scheduleDraw();
            return;
        }
        if (key.name === 'paste') {
            if (this.surface && typeof this.surface.captureMouse === 'function') {
                this.surface.captureMouse();
            }
            pasteIntoChatbox(this, key.text);
            return;
        }
        if (this.completion && this.handleCompletionKey(key))
            return;
        if (this.handleScrollKey(key))
            return;
        const isModeControl = Boolean((key.ctrl && key.name === 'g') || (key.shift && key.name === 'tab' && this.onCycleMode));
        const control = (key.ctrl && key.name === 'g') ? this.onOpenMode
            : (key.shift && key.name === 'tab' && this.onCycleMode) ? this.onCycleMode
                : key.alt && key.name === 'm' ? this.onOpenModel
                    : key.ctrl && key.name === 't' ? this.onOpenVariant
                        : key.alt && key.name === 't' ? (this.onOpenVariantList || this.onOpenVariant) : null;
        if (control) {
            if (this.busy && !isModeControl) {
                this.notice = 'Finish or interrupt the current turn before switching controls';
                this.scheduleDraw();
            }
            else {
                Promise.resolve(control()).catch((error) => {
                    this.notice = this.sanitizeSingleLine(error instanceof Error ? error.message : String(error));
                    this.scheduleDraw();
                });
            }
            return;
        }
        switch (key.name) {
            case 'escape': return this.handleEscape();
            case 'enter':
                if (key.alt || key.shift) {
                    this.editor.newline();
                    return this.refreshCompletion();
                }
                return this.submit();
            case 'tab':
                if (key.shift)
                    return;
                return this.openCompletion(true);
            case 'backspace':
                if (key.alt)
                    this.editor.killWordLeft();
                else
                    this.editor.backspace();
                return this.refreshCompletion();
            case 'delete':
                this.editor.deleteForward();
                return this.refreshCompletion();
            case 'left': return (key.ctrl || key.alt) ? this.editor.moveWordLeft(Boolean(key.shift)) : this.editor.moveLeft(Boolean(key.shift));
            case 'right': return (key.ctrl || key.alt) ? this.editor.moveWordRight(Boolean(key.shift)) : this.editor.moveRight(Boolean(key.shift));
            case 'home': return this.editor.moveHome(Boolean(key.shift));
            case 'end': return this.editor.moveEnd(Boolean(key.shift));
            case 'up':
                if (key.shift)
                    return this.editor.moveUp(true);
                return this.historyOrMove(-1);
            case 'down':
                if (key.shift)
                    return this.editor.moveDown(true);
                return this.historyOrMove(1);
            case 'pageup':
                if (key.shift) {
                    this.editor.moveHome(true);
                    this.editor.line = 0;
                    return;
                }
                break;
            case 'pagedown':
                if (key.shift) {
                    this.editor.moveEnd(true);
                    this.editor.line = this.editor.lines.length - 1;
                    return;
                }
                break;
            case 'char':
                this.editor.insert(key.text);
                return this.refreshCompletion();
            default: break;
        }
        if (key.ctrl) {
            switch (key.name) {
                case 'a': return this.editor.moveHome();
                case 'e': return this.editor.moveEnd();
                case 'k':
                    this.editor.killToEnd();
                    return this.refreshCompletion();
                case 'u':
                    this.editor.killToStart();
                    return this.refreshCompletion();
                case 'w':
                    this.editor.killWordLeft();
                    return this.refreshCompletion();
                case 'y':
                    this.editor.yank();
                    return this.refreshCompletion();
                case 'x': {
                    if (this.cutSelection())
                        return;
                    break;
                }
                case 'p': return this.openPalette();
                case 'l': return this.clearScreen();
                case 'o': return this.expand();
                case 'v': return this.pasteClipboard();
                default: break;
            }
        }
        if (key.alt && key.name === 'a') {
            this.editor.selectAll();
            this.notice = 'selected all input text';
            this.scheduleDraw();
            return;
        }
        if (key.alt && key.name === 'x') {
            if (this.cutSelection())
                return;
        }
        if (key.alt && (key.name === 'c' || key.name === 'w')) {
            const text = this.editor.hasSelection
                ? this.editor.getSelectedText()
                : this.editor.getText();
            if (text) {
                writeClipboardSync(text);
                this.editor.killRing = text;
                this.notice = this.editor.hasSelection
                    ? `copied selection (${text.length} chars) to clipboard`
                    : 'copied input to clipboard';
            }
            else {
                this.notice = 'input is empty (nothing to copy)';
            }
            this.scheduleDraw();
            return;
        }
        if (key.alt && key.name === 'v')
            return this.pasteClipboard();
        if (key.alt && key.name === 'b')
            return this.editor.moveWordLeft();
        if (key.alt && key.name === 'f')
            return this.editor.moveWordRight();
    }
    handleScrollKey(key) {
        const viewport = this.surface && this.surface.viewport;
        if (key.name === 'mouse') {
            if (handleTurnRailMouse(key, this.surface, this))
                return true;
            if (this.messageActionLoop && isMouseMotion(key.sequence)) {
                return handleMessageMouse(this, this.messageActionLoop, key);
            }
            if (handleScrollbarMouse(key, viewport, this.surface, this))
                return true;
            if (!this.layer && this.messageActionLoop)
                return handleMessageMouse(this, this.messageActionLoop, key);
            return true;
        }
        if (key.name === 'wheel') {
            if (!viewport || !key.wheel)
                return true;
            const layout = this.surface?.turnRailLayout;
            const card = layout?.cardRect;
            const pointerX = key.wheel.x;
            const pointerY = key.wheel.y;
            const relativeY = pointerY - (Number.isFinite(layout?.stageTop) ? layout.stageTop : 0);
            if (card && Array.isArray(card.groupTurns) &&
                Number.isFinite(pointerX) && Number.isFinite(pointerY) &&
                pointerX >= card.x && pointerX < card.x + card.width &&
                relativeY >= card.y && relativeY < card.y + card.height &&
                (key.wheel.direction === 'up' || key.wheel.direction === 'down')) {
                const previous = Number.isFinite(this.surface.turnRailCardOffset)
                    ? this.surface.turnRailCardOffset : 0;
                const maximum = Number.isFinite(card.maxOffset) ? Math.max(0, card.maxOffset) : 0;
                const change = key.wheel.direction === 'up' ? -1 : 1;
                const current = Math.max(0, Math.min(maximum, previous + change));
                if (current !== previous) {
                    this.surface.turnRailCardOffset = current;
                    this.scheduleDraw();
                }
                return true;
            }
            if (this.renderer?.scrollCodePanel?.(key, this.surface)) {
                if (typeof this.scheduleDraw === 'function')
                    this.scheduleDraw();
                else
                    this.draw();
                return true;
            }
            if (this.renderer?.scrollThinkingPanel?.(key, this.surface)) {
                if (typeof this.scheduleDraw === 'function')
                    this.scheduleDraw();
                else
                    this.draw();
                return true;
            }
            return handleViewportWheel(key, viewport, this.surface, this);
        }
        if (!viewport)
            return false;
        const clearTurnRailFocus = () => {
            if (!this.surface)
                return;
            this.surface.activeTurnIndex = null;
            this.surface.hoveredTurnIndex = null;
            this.surface.hoveredTurnAnchorY = null;
        };
        if (key.name === 'pageup') {
            clearTurnRailFocus();
            if (key.shift)
                viewport.toTop();
            else
                viewport.pageUp();
            return true;
        }
        if (key.name === 'pagedown') {
            clearTurnRailFocus();
            if (key.shift)
                viewport.toBottom();
            else
                viewport.pageDown();
            return true;
        }
        if (key.shift && key.name === 'up') {
            if (!this.editor.isEmpty)
                return false;
            clearTurnRailFocus();
            viewport.lineUp();
            return true;
        }
        if (key.shift && key.name === 'down') {
            if (!this.editor.isEmpty)
                return false;
            clearTurnRailFocus();
            viewport.lineDown();
            return true;
        }
        if (key.alt && key.ctrl && key.name === 'u') {
            clearTurnRailFocus();
            viewport.halfPageUp();
            return true;
        }
        if (key.alt && key.ctrl && key.name === 'd') {
            clearTurnRailFocus();
            viewport.halfPageDown();
            return true;
        }
        const jumpViewport = (direction, kinds) => {
            clearTurnRailFocus();
            viewport.jump(direction, kinds);
            return true;
        };
        if (key.alt && key.name === ',')
            return jumpViewport(-1, ['step']);
        if (key.alt && key.name === '.')
            return jumpViewport(1, ['step']);
        if ((key.alt && key.name === '[') || (key.alt && key.name === '<'))
            return jumpViewport(-1, ['user']);
        if ((key.alt && key.name === ']') || (key.alt && key.name === '>'))
            return jumpViewport(1, ['user']);
        if (key.alt && key.name === 'u') {
            this.offerUndo();
            return true;
        }
        return false;
    }
    offerUndo() {
        const surface = this.surface;
        if (!surface)
            return;
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
        const meta = mark?.meta || {};
        const where = meta.path ? this.sanitizeSingleLine(shortenHome(meta.path)) : 'files changed this task';
        const rawStep = meta.step == null ? '' : this.sanitizeSingleLine(meta.step);
        const step = rawStep ? ` at step ${rawStep}` : '';
        if (this.editor.isEmpty) {
            this.editor.setText('/undo');
            this.notice = `restore point${step} ${GLYPHS.dot} ${where} ${GLYPHS.dot} enter previews, --apply writes`;
        }
        else {
            this.notice = `restore point${step} ${GLYPHS.dot} ${where} ${GLYPHS.dot} run /undo to preview`;
        }
    }
    sanitizeSingleLine(value) {
        return value == null ? '' : safeDisplay(String(value)).replace(/\s+/g, ' ').trim();
    }
    cutSelection() {
        if (!this.editor.hasSelection)
            return false;
        const text = this.editor.getSelectedText();
        writeClipboardSync(text);
        this.editor.killRing = text;
        this.editor.deleteSelection();
        this.notice = `cut selection (${text.length} chars) to clipboard`;
        this.refreshCompletion();
        return true;
    }
    handleCtrlC() {
        handlePromptCtrlC(this, () => [`${paint('warn', GLYPHS.cross)} ${dim('interrupted')}`], CTRL_C_WINDOW_MS);
    }
    handleEscape() {
        handlePromptEscape(this, () => [`${paint('warn', GLYPHS.cross)} ${dim('interrupted')}`]);
    }
    interrupt() {
        triggerTurnInterrupt(this, () => [`${paint('warn', GLYPHS.cross)} ${dim('interrupted')}`]);
    }
    expand() {
        this.erase();
        this.onExpand();
        this.notice = '';
    }
    clearScreen() {
        if (this.surface) {
            this.surface.flushAndClear();
            return;
        }
        this.erase();
        // The one clear Causyne may perform: the user pressed ctrl+L and asked for it.
        // UX-01 forbids clearing the terminal on the app's own initiative.
        this.writeControl('\x1b[2J\x1b[H');
        this.drawnRows = 0;
        this.cursorRow = 0;
    }
    historyOrMove(direction) {
        if (direction === -1 && this.editor.line > 0) {
            this.editor.moveUp();
            return;
        }
        if (direction === 1 && this.editor.line < this.editor.lines.length - 1) {
            this.editor.moveDown();
            return;
        }
        const text = direction === -1
            ? this.history.previous(this.editor.getText())
            : this.history.next();
        if (text === null || text === undefined)
            return;
        this.editor.setText(text);
    }
    // -------------------------------------------------------------------------
    // Completion
    // -------------------------------------------------------------------------
    bindFileIndex(index) {
        if (typeof this._unsubscribeFileIndex === 'function')
            this._unsubscribeFileIndex();
        this._unsubscribeFileIndex = index.subscribe(() => {
            if (this.index !== index || !this.active)
                return;
            const trigger = detectTrigger(this.editor.getText(), this.cursorOffset());
            if (!trigger || trigger.kind !== 'file')
                return;
            this.openCompletion(false);
            if (index.truncated)
                this.notice = 'Workspace file index reached its safety limit; narrow the project root.';
            else if (this.notice === 'Indexing workspace files…')
                this.notice = '';
            this.scheduleDraw();
        });
        void index.ensure();
    }
    setWorkingRoot(newRoot, focusDir = null) {
        if (typeof this._unsubscribeFileIndex === 'function')
            this._unsubscribeFileIndex();
        this.index?.dispose();
        this.root = newRoot;
        this.focusDir = focusDir;
        this.index = new FileIndex(newRoot);
        this.bindFileIndex(this.index);
        const trigger = detectTrigger(this.editor.getText(), this.cursorOffset());
        if (trigger?.kind === 'file')
            this.openCompletion(false);
    }
    cursorOffset() {
        const before = this.editor.lines.slice(0, this.editor.line)
            .reduce((total, line) => total + line.join('').length + 1, 0);
        return before + (this.editor.lines[this.editor.line] ?? [])
            .slice(0, this.editor.col).join('').length;
    }
    openCompletion(force = false) {
        const text = this.editor.getText();
        const result = suggest(text, this.cursorOffset(), {
            root: this.root,
            index: this.index,
            focusDir: this.focusDir
        });
        if (!result) {
            if (force)
                this.notice = 'nothing to complete here';
            this.completion = null;
            return;
        }
        this.completion = result;
        this.selected = 0;
    }
    refreshCompletion() {
        if (!this.completion) {
            const text = this.editor.getText();
            const offset = this.cursorOffset();
            const opens = Boolean(detectTrigger(text, offset));
            if (opens)
                this.openCompletion(false);
            return;
        }
        this.openCompletion(false);
        if (this.completion)
            this.selected = Math.min(this.selected, this.completion.items.length - 1);
    }
    completionIsExact() {
        if (!this.completion || this.completion.items.length !== 1)
            return false;
        const item = this.completion.items[0];
        if (!item)
            return false;
        if (this.completion.kind === 'command-argument')
            return item.value === this.completion.query;
        if (this.completion.kind === 'command')
            return item.value === this.editor.getText();
        return false;
    }
    handleCompletionKey(key) {
        if (!this.completion)
            return false;
        if (key.name === 'up') {
            this.moveSelection(-1);
            return true;
        }
        if (key.name === 'down') {
            this.moveSelection(1);
            return true;
        }
        if (key.name === 'wheel') {
            const direction = key.wheel && key.wheel.direction;
            if (direction === 'up')
                this.moveSelectionClamped(-1);
            else if (direction === 'down')
                this.moveSelectionClamped(1);
            this.scheduleDraw();
            return true;
        }
        if (key.name === 'pageup' && !key.shift) {
            this.moveSelectionClamped(-MAX_VISIBLE);
            this.scheduleDraw();
            return true;
        }
        if (key.name === 'pagedown' && !key.shift) {
            this.moveSelectionClamped(MAX_VISIBLE);
            this.scheduleDraw();
            return true;
        }
        if (key.name === 'mouse') {
            if (key.mouse && key.mouse.pressed && key.mouse.button === 0 && !isMouseMotion(key.sequence)) {
                let item = null;
                const hasZeroY = Number.isFinite(key.mouse.y);
                const rawMouseRow = hasZeroY
                    ? Math.floor(key.mouse.y)
                    : (Number.isFinite(key.mouse.row) ? Math.floor(key.mouse.row) : Number.NaN);
                if (this.pickerLayout && Number.isFinite(rawMouseRow)) {
                    const stageHeight = this.surface?.stage?.height || this.out?.rows || process.stdout.rows || 24;
                    const termRows = Number.isFinite(this.out?.rows) && this.out.rows > 0
                        ? Math.floor(this.out.rows)
                        : stageHeight;
                    const promptTop = hasZeroY
                        ? Math.max(0, termRows - this.pickerLayout.totalPromptRows)
                        : Math.max(1, stageHeight - this.pickerLayout.totalPromptRows + 1);
                    const pickerTop = promptTop + this.pickerLayout.pickerStart;
                    const pickerBottom = pickerTop + this.pickerLayout.pickerCount - 1;
                    const mouseX = Number.isFinite(key.mouse.x) ? Math.floor(key.mouse.x) : Number.NaN;
                    const mainW = this.surface
                        ? sessionMainWidth(this.surface.width, Boolean(this.surface.homeInfo), this.surface.env)
                        : Infinity;
                    const inMainColumn = !Number.isFinite(mouseX) || (mouseX >= 0 && mouseX < mainW);
                    if (inMainColumn && rawMouseRow >= pickerTop && rawMouseRow <= pickerBottom) {
                        const items = Array.isArray(this.completion.items) ? this.completion.items : [];
                        const total = items.length;
                        const windowStart = Math.max(0, Math.min(this.selected - MAX_VISIBLE + 1, total - MAX_VISIBLE));
                        const index = windowStart + (rawMouseRow - pickerTop);
                        if (index >= 0 && index < total) {
                            this.selected = index;
                            item = items[index];
                        }
                    }
                    else {
                        this.completion = null;
                        this.scheduleDraw();
                        return true;
                    }
                }
                else {
                    const items = Array.isArray(this.completion.items) ? this.completion.items : [];
                    item = items[this.selected];
                }
                if (item) {
                    if (this.completion.kind !== 'file' && this.completion.inline) {
                        const selectedCommand = this.completion.kind === 'command'
                            ? item.value : `/${this.completion.command} ${item.value}`;
                        this.runInlineSlashSelection(selectedCommand);
                        return true;
                    }
                    if (this.completion.kind === 'command') {
                        if (typeof item.value === 'string' && (item.value.startsWith('/skills ') || item.value.startsWith('/skill '))) {
                            this.acceptCompletion();
                            return true;
                        }
                        this.submitPickedCommand(item.value);
                        return true;
                    }
                    if (this.completion.kind === 'command-argument') {
                        this.submitPickedCommand(`/${this.completion.command} ${item.value}`);
                        return true;
                    }
                    this.acceptCompletion();
                    return true;
                }
            }
            return true;
        }
        if (key.name === 'enter' && !key.alt && !key.shift) {
            const item = this.completion.items && this.completion.items[this.selected];
            if (item && this.completion.kind !== 'file' && this.completion.inline) {
                const selectedCommand = this.completion.kind === 'command'
                    ? item.value : `/${this.completion.command} ${item.value}`;
                this.runInlineSlashSelection(selectedCommand);
                return true;
            }
            if (this.completion.kind === 'command' && item) {
                if (typeof item.value === 'string' && (item.value.startsWith('/skills ') || item.value.startsWith('/skill '))) {
                    this.acceptCompletion();
                    return true;
                }
                this.submitPickedCommand(item.value);
                return true;
            }
            if (this.completionIsExact()) {
                this.completion = null;
                return false;
            }
            this.acceptCompletion();
            return true;
        }
        if (key.name === 'tab') {
            if (this.completion.kind !== 'file' && this.completion.inline) {
                this.notice = 'Press Enter to run the selected command; your unsent draft is preserved.';
                this.scheduleDraw();
                return true;
            }
            this.acceptCompletion();
            return true;
        }
        if (key.name === 'escape') {
            const dismissed = this.completion;
            this.completion = null;
            if (!(dismissed.kind !== 'file' && dismissed.inline) && /^\s*\/[a-z0-9_?-]*$/i.test(this.editor.getText())) {
                this.editor.clear();
            }
            this.scheduleDraw();
            return true;
        }
        return false;
    }
    moveSelection(direction) {
        const count = Array.isArray(this.completion?.items) ? this.completion.items.length : 0;
        if (count === 0)
            return;
        this.selected = (((this.selected + direction) % count) + count) % count;
    }
    moveSelectionClamped(delta) {
        const count = Array.isArray(this.completion?.items) ? this.completion.items.length : 0;
        if (count === 0)
            return;
        this.selected = Math.max(0, Math.min(count - 1, this.selected + delta));
    }
    submitPickedCommand(value) {
        this.completion = null;
        this.editor.setText(value);
        this.submit();
    }
    runInlineSlashSelection(value) {
        const trigger = this.completion;
        if (!trigger || trigger.kind === 'file' || !trigger.inline) {
            this.submitPickedCommand(value);
            return;
        }
        const currentText = this.editor.getText();
        const currentCursor = this.cursorOffset();
        let remaining;
        try {
            remaining = removeInlineSlashToken(currentText, currentCursor, trigger);
        }
        catch {
            this.notice = 'The command text changed. Reopen the / menu and select again.';
            this.completion = null;
            this.scheduleDraw();
            return;
        }
        const consumeDraft = isInlineSkillInvocation(value) && remaining.text.trim().length > 0;
        const commandText = consumeDraft ? `${value} ${remaining.text.trim()}` : value;
        if (this.busy && this.queue.length >= 32 && !/^\/(?:stop|interrupt)$/i.test(commandText)) {
            this.notice = '32 queued messages: command not submitted; your draft is unchanged.';
            this.scheduleDraw();
            return;
        }
        this.completion = null;
        try {
            this.editor.setText(commandText);
            this.submit();
        }
        finally {
            this.editor.setText(consumeDraft ? '' : remaining.text);
            if (!consumeDraft)
                this.setCursorOffset(remaining.cursor);
            this.completion = null;
            this.scheduleDraw();
        }
    }
    acceptCompletion() {
        if (!this.completion)
            return;
        const item = this.completion.items[this.selected];
        if (!item) {
            this.completion = null;
            return;
        }
        const applied = applyCompletion(this.editor.getText(), this.cursorOffset(), this.completion, item);
        this.editor.setText(applied.text);
        this.setCursorOffset(applied.cursor);
        this.completion = null;
        this.refreshCompletion();
    }
    setCursorOffset(offset) {
        let remaining = Math.max(0, Number.isFinite(offset) ? offset : 0);
        for (let index = 0; index < this.editor.lines.length; index++) {
            const line = this.editor.lines[index] ?? [];
            const units = line.join('').length;
            if (remaining <= units || index === this.editor.lines.length - 1) {
                let column = 0;
                let consumed = 0;
                while (column < line.length && consumed + (line[column]?.length ?? 0) <= remaining) {
                    consumed += line[column]?.length ?? 0;
                    column++;
                }
                this.editor.line = index;
                this.editor.col = column;
                return;
            }
            remaining -= units + 1;
        }
    }
    // -------------------------------------------------------------------------
    // Drawing
    // -------------------------------------------------------------------------
    queuedPreviewRows(width) {
        if (this.queue.length === 0)
            return [];
        const last = this.queue[this.queue.length - 1];
        const text = typeof last === 'string' ? last
            : last && typeof last.text === 'string' ? last.text : 'pending action';
        const prefix = `  Queued (${this.queue.length}): `;
        const available = Math.max(0, width - visibleWidth(prefix) - 2);
        const preview = safeDisplay(text.slice(0, 160).replace(/\s+/g, ' ').trim());
        return [dim(prefix + truncate(preview, available, GLYPHS.ellipsis))];
    }
    clampRows(rows, width) {
        const limit = Math.max(1, width - 1);
        return rows.map((row) => (visibleWidth(row) <= limit ? row : truncate(row, limit, '')));
    }
    erase() {
        if (this.surface)
            return;
        if (this.drawnRows === 0) {
            this.out.write('\r');
            return;
        }
        if (this.cursorRow > 0)
            this.out.write(`\x1b[${this.cursorRow}A`);
        this.out.write('\r\x1b[J');
        this.drawnRows = 0;
        this.cursorRow = 0;
    }
    draw() {
        if (this.resizeTimer)
            return;
        if (!this.active)
            return;
        this.erase();
        const width = this.width();
        if (this.layer) {
            this.drawLayer(width);
            return;
        }
        const { boxWidth, inset, editorWidth } = composerGeometry(width, visibleWidth(GLYPHS.barHeavy || GLYPHS.bar), GUTTER);
        const inner = editorWidth;
        const layout = this.editor.render(editorWidth, '');
        const start = Math.max(0, Math.min(layout.cursorRow - MAX_PROMPT_ROWS + 1, layout.rows.length - MAX_PROMPT_ROWS));
        const top = Math.max(0, start);
        const windowRows = layout.rows.slice(top, top + MAX_PROMPT_ROWS);
        const caretRow = layout.cursorRow - top;
        let body = windowRows.slice();
        if (!this.editor.isEmpty) {
            body = body.map((line) => {
                if (typeof line !== 'string' || !line.includes('[Image '))
                    return line;
                return line.replace(/\[Image (\d+)\]/g, (_m, num) => {
                    return paint('warn', bold(`[Image ${num}]`));
                });
            });
        }
        if (this.editor.isEmpty && !this.completion) {
            const idle = fitHints([`try "${this.example}"`, '/ commands', '@ files', '^V image'], Math.max(8, inner), 'ask anything');
            body = [dim(this.busy ? 'type to queue a message…' : idle)];
        }
        const agent = this.completion ? null : this.agentRow(inner);
        if (agent)
            body = body.concat(['', agent]);
        const rows = Number(this.out && this.out.rows);
        const roomy = !Number.isFinite(rows) || rows >= ROOMY_TERMINAL_ROWS;
        const padTop = (!Number.isFinite(rows) || rows >= CRAMPED_TERMINAL_ROWS) ? PROMPT_PAD_TOP : 0;
        const padBottom = roomy ? PROMPT_PAD_BOTTOM : 0;
        const padded = new Array(padTop).fill('')
            .concat(body, new Array(padBottom).fill(''));
        const boxRows = barBlock(padded, {
            width: boxWidth,
            role: this.busy ? 'accent' : 'user',
            filled: true,
            surface: 'surface',
            punctuate: false
        });
        const usageCardRows = this.usageCard ? renderUsageCardRows(this.usageCard, boxWidth)
            : this.statusCard !== null ? this.statusCardRows(boxWidth) : [];
        const planRows = this.planRows(width);
        const pickerRows = this.completion ? this.pickerRows(width) : [];
        this.pickerLayout = this.completion ? {
            pickerStart: usageCardRows.length + planRows.length + boxRows.length,
            pickerCount: pickerRows.length,
            totalPromptRows: 0
        } : null;
        const queuedRows = this.queuedPreviewRows(width);
        const cleanNotice = this.notice ? this.sanitizeSingleLine(this.notice) : '';
        const noticeRows = cleanNotice ? [dim(`  ${cleanNotice}`)] : [];
        const status = this.statusRow(width);
        const gap = status.length > 0 ? new Array(FOOTER_GAP).fill('') : [];
        const all = this.clampRows(usageCardRows.concat(planRows, boxRows, pickerRows, queuedRows, noticeRows, gap, status), width);
        if (this.pickerLayout)
            this.pickerLayout.totalPromptRows = all.length;
        const availableWidth = this.surface?.composeAvailableWidth
            ? this.surface.composeAvailableWidth()
            : sessionMainWidth(this.surface?.width || terminalWidth(), false, this.surface?.env);
        const positioned = this.surface
            ? (this.surface.homeInfo ? centerRows(all, this.surface.width) : sessionRows(all, availableWidth))
            : { rows: all, inset: 0 };
        this.present(positioned.rows, usageCardRows.length + planRows.length + caretRow + padTop, layout.cursorCol + inset + positioned.inset);
    }
    present(all, caretRow, caretCol) {
        const rows = Array.isArray(all) ? all : [];
        const maxRow = Math.max(0, rows.length - 1);
        const safeRow = Number.isFinite(caretRow) ? Math.max(0, Math.min(maxRow, Math.floor(caretRow))) : 0;
        const safeCol = Number.isFinite(caretCol) ? Math.max(0, Math.floor(caretCol)) : 0;
        const hideCursor = Boolean(this.busy && this.editor.isEmpty);
        if (this.surface) {
            this.drawnRows = 0;
            this.cursorRow = 0;
            this.surface.present(rows, {
                row: safeRow,
                col: safeCol,
                hideCursor,
                modal: Boolean(this.layer),
                inline: Boolean(this.layer && !isStartupDialog(this.surface))
            });
            return;
        }
        this.out.write(rows.join('\n'));
        this.drawnRows = rows.length;
        const below = rows.length - 1 - safeRow;
        if (below > 0)
            this.out.write(`\x1b[${below}A`);
        this.cursorRow = safeRow;
        this.out.write('\r');
        if (safeCol > 0)
            this.out.write(`\x1b[${safeCol}C`);
        if (hideCursor) {
            this.out.write('\x1b[?25l');
        }
        else {
            this.out.write('\x1b[?25h');
        }
    }
    attachSurface(surface) {
        this.surface = surface || null;
        if (!surface)
            return;
        surface.onDirty = () => this.scheduleDraw();
    }
    commit(kind, produce) {
        const clamped = (width) => this.clampRows(produce(width), width);
        if (this.surface) {
            this.surface.commit(kind, clamped);
            return;
        }
        this.erase();
        this.out.write(clamped(this.width()).join('\n') + '\n');
    }
    drawLayer(width) {
        const preferredHeight = typeof this.layer.preferredHeight === 'function'
            ? this.layer.preferredHeight()
            : 14;
        if (this.layer.messageActions && this.surface?.presentMessageActions) {
            const availableWidth = this.surface.composeAvailableWidth
                ? this.surface.composeAvailableWidth()
                : sessionMainWidth(this.surface.width, false, this.surface.env);
            const requestedWidth = typeof this.layer.preferredWidth === 'function'
                ? this.layer.preferredWidth(Math.max(8, availableWidth - 3))
                : (this.layer.width || 64);
            const panelWidth = dialogWidth(Math.max(8, availableWidth - 3), requestedWidth);
            const panel = panelRows(this.layer, panelWidth, preferredHeight);
            this.surface.presentMessageActions(panel, this.layer);
            return;
        }
        if (isStartupDialog(this.surface)) {
            const view = startupDialogView(this.layer, this.surface.width, this.surface.stage.maxHeight);
            this.present(view.rows, view.caretRow, view.caretCol);
            return;
        }
        const inline = Boolean(this.surface && !this.surface.homeInfo);
        const availableWidth = inline
            ? (this.surface.composeAvailableWidth
                ? this.surface.composeAvailableWidth()
                : sessionMainWidth(this.surface.width, false, this.surface.env))
            : width;
        const panelWidth = dialogWidth(availableWidth, this.layer.width || 64);
        const stageMax = this.surface?.stage?.maxHeight || this.out?.rows || 24;
        const statusReserve = 2;
        const availableDialogRows = Math.max(4, stageMax - statusReserve);
        const maxHeight = dialogHeight(availableDialogRows, preferredHeight);
        const panel = panelRows(this.layer, panelWidth, maxHeight);
        const status = this.statusRow(width);
        const all = this.clampRows(panel.concat(status), width);
        const cursor = this.layer.cursor;
        const centered = this.surface ? centerRows(all, availableWidth) : { rows: all, inset: 0 };
        const stageHeight = this.surface?.stage?.height || this.out?.rows || all.length;
        const outRows = Number.isFinite(this.out?.rows) && this.out.rows > 0
            ? Math.floor(this.out.rows)
            : stageHeight;
        this.layer.panelGeometry = {
            inset: centered.inset,
            optionScreenRow: Math.max(0, outRows - status.length - 2)
        };
        this.present(centered.rows, cursor ? 1 + cursor.y : 0, (cursor ? 2 + cursor.x : 0) + centered.inset);
    }
    pickerRows(width) {
        if (!this.completion)
            return [];
        const rows = renderPicker(this.completion.items, this.selected, width);
        const labelWidth = Math.min(36, rows.reduce((max, row) => Math.max(max, visibleWidth(row.label)), 0));
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
        const matched = this.completion.total || this.completion.items.length;
        const hidden = matched - drawn.length;
        if (hidden > 0)
            drawn.push(dim(`    ${GLYPHS.ellipsis} ${hidden} more`));
        if (this.completion.kind !== 'file' && this.completion.inline) {
            drawn.push(dim('    ' + truncate('Enter run  ·  Esc dismiss  ·  draft protected', Math.max(0, width - 5))));
        }
        return drawn;
    }
}
export function keyHints(width = terminalWidth()) {
    const parts = [
        'enter send', 'alt+enter newline', 'ctrl+p palette', '/ commands', '@ files',
        '↑ history', 'tab complete', 'esc interrupt', 'ctrl+o expand'
    ];
    const separator = `  ${GLYPHS.dot}  `;
    const kept = parts.slice();
    while (kept.length > 1 && visibleWidth(kept.join(separator)) > width - 1)
        kept.pop();
    return HAS_COLOR
        ? kept.map((part) => dim(part)).join(dim(separator))
        : kept.join(separator);
}
export { MAX_VISIBLE };
