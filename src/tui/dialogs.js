// The concrete dialogs.
//
// Every one of these is the SelectList or a scrolling text pane inside a Layer.
// That is the payoff of building the primitives properly: opencode needs twenty
// `dialog-*.tsx` files because each one re-declares its own layout; here a
// picker is a title, a list of items and a callback.
//
// The one that is not a picker is ApprovalLayer, and it is the reason this file
// exists at all. Causyne's approval used inquirer, which means the question is
// asked in the scrollback, below whatever the agent last printed, with the diff
// already scrolled away above it. As a modal the risk badge, the tool, the
// arguments and the full scrollable diff sit in one frame that the user cannot
// lose — and neither reference does this: openclaw approves in a plain prompt,
// opencode's permission dialog does not scroll its diff by keyboard.
//
// Pure Node over ./selectList.js, ./overlay.js, ./theme.js, ./text.js.
// No dependency, no shell.
import { Layer, dialogHint } from './overlay.js';
import { SelectList } from './selectList.js';
import { LineEditor } from './lineEditor.js';
import { paint, bold, dim, badge, GLYPHS } from './theme.js';
import { truncate, wrap, visibleWidth, safeDisplay, shortenHome } from './text.js';
import { approvalDiff } from './diff.js';
import { isChar, isMouseMotion } from './keys.js';
import { readClipboardSync } from './clipboardSync.js';
const MAX_DIALOG_PASTE_CHARS = 65536;
const cleanDialogText = (value) => (value == null ? '' : safeDisplay(String(value)).replace(/\s+/g, ' ').trim());
function safeJsonPreview(value) {
    try {
        const serialized = JSON.stringify(value);
        return serialized === undefined ? String(value) : serialized;
    }
    catch {
        return String(value);
    }
}
/**
 * A picker. `items` are SelectList items; `onPick(item)` fires on enter.
 *
 * onPick may return 'keep' to leave the dialog open — which is what a theme
 * picker wants, so the user can see each theme applied before committing.
 */
export class SelectLayer extends Layer {
    list;
    onPick;
    settled;
    constructor(options = {}) {
        const opts = options && typeof options === 'object' ? options : {};
        super({ width: opts.width || 68, height: opts.height || 18, ...opts });
        this.list = new SelectList((opts.items || []), {
            placeholder: opts.placeholder,
            emptyText: opts.emptyText,
            showFilter: opts.showFilter
        });
        this.onPick = opts.onPick || null;
        this.settled = false;
        this.footer = opts.footer || dialogHint();
    }
    /** Dismissal must resolve pending picker flows, just like text inputs. */
    answer() {
        if (this.settled)
            return;
        this.settled = true;
        if (this.onPick)
            this.onPick(null);
    }
    preferredHeight() {
        // filter row + rule + one row per item (+ its category header) + frame.
        const categories = new Set(this.list.filtered.map((entry) => entry.item.category).filter(Boolean));
        return 2 + this.list.filtered.length + categories.size + 2;
    }
    body(width = 64, height = 16) {
        const { rows } = this.list.render(width, height);
        this.cursor = { x: this.list.cursorColumn(), y: 0 };
        return rows;
    }
    key(event) {
        // Scroll by the budget the RENDERER used, not by one derived from the
        // layer's configured height. The panel gives the body
        // `min(preferredHeight, maxHeight) - 2` rows and the list then spends two
        // more on the filter and its rule and one on the position counter — so this
        // used to move the selection by 17 rows through a list that was drawing 15.
        // The list publishes what it actually budgeted on its last render; before
        // the first render there is nothing to disagree with, so the estimate stands.
        const visibleRows = this.list.lastItemRows || Math.max(1, this.height - 5);
        const action = this.list.handleKey(event, visibleRows);
        if (action === 'select') {
            const item = this.list.current;
            this.settled = true;
            const result = this.onPick ? this.onPick(item) : null;
            if (result === 'keep' || result === 'handled') {
                this.settled = false;
                return 'handled';
            }
            return 'close';
        }
        if (action === 'cancel')
            return 'close';
        return action ? 'handled' : null;
    }
}
export class InputLayer extends Layer {
    editor;
    lines;
    mask;
    placeholder;
    onSubmit;
    onCancel;
    settled;
    constructor(options = {}) {
        const opts = options && typeof options === 'object' ? options : {};
        super({ width: opts.width || 68, height: opts.height || 10, ...opts });
        this.editor = new LineEditor(String(opts.value == null ? '' : opts.value));
        this.lines = Array.isArray(opts.lines) ? [...opts.lines] : [];
        this.mask = opts.mask === true;
        this.placeholder = opts.placeholder || '';
        this.onSubmit = opts.onSubmit || null;
        this.onCancel = opts.onCancel || null;
        this.footer = opts.footer || `enter accept  ${GLYPHS.dot}  esc cancel`;
        this.settled = false;
    }
    // Blurb rows + a blank + the input row, inside the frame.
    preferredHeight() { return this.lines.length + (this.lines.length ? 1 : 0) + 1 + 2; }
    /** Dismissal is a cancel, so the caller's promise can never hang. */
    answer() {
        if (this.settled)
            return;
        this.settled = true;
        if (this.onCancel)
            this.onCancel();
    }
    body(width = 64) {
        const safeWidth = Number.isFinite(width) && width > 0 ? Math.floor(width) : 8;
        const rows = this.lines.map((line) => truncate(cleanDialogText(line), safeWidth, GLYPHS.ellipsis));
        if (rows.length)
            rows.push('');
        const raw = this.editor.getText();
        const shown = this.mask ? GLYPHS.bullet.repeat(Array.from(raw).length) : cleanDialogText(raw);
        const cleanPlaceholder = cleanDialogText(this.placeholder);
        const text = shown.length === 0 && cleanPlaceholder ? dim(cleanPlaceholder) : shown;
        const prefix = paint('accent', `${GLYPHS.arrow} `);
        rows.push(truncate(prefix + text, safeWidth, GLYPHS.ellipsis));
        // Park the caret after what is displayed — which for a masked field is the
        // dot count, not the character count, or the caret drifts off the value —
        // and never past the rightmost body column.
        const before = this.mask
            ? Array.from(raw.slice(0, this.editor.col)).length
            : visibleWidth(cleanDialogText(raw.slice(0, this.editor.col)));
        const maxCol = Math.max(0, safeWidth - 1);
        this.cursor = { x: Math.min(maxCol, 2 + before), y: rows.length - 1 };
        return rows;
    }
    key(event) {
        if (!event)
            return null;
        switch (event.name) {
            case 'escape':
                return 'close';
            case 'enter':
            case 'return': {
                if (this.settled)
                    return 'close';
                this.settled = true;
                const value = this.editor.getText();
                if (this.onSubmit)
                    this.onSubmit(value);
                return 'close';
            }
            case 'backspace':
                if (event.alt)
                    this.editor.killWordLeft();
                else
                    this.editor.backspace();
                return 'handled';
            case 'delete':
                this.editor.deleteForward();
                return 'handled';
            case 'left':
                this.editor.moveLeft();
                return 'handled';
            case 'right':
                this.editor.moveRight();
                return 'handled';
            case 'home':
                this.editor.moveHome();
                return 'handled';
            case 'end':
                this.editor.moveEnd();
                return 'handled';
            case 'char':
                this.editor.insert(event.text);
                return 'handled';
            case 'paste': {
                const clean = String(event.text || '').replace(/[\r\n]+/g, '').trim();
                if (clean)
                    this.editor.insert(clean);
                return 'handled';
            }
            default: break;
        }
        if (event.ctrl) {
            switch (event.name) {
                case 'a':
                    this.editor.moveHome();
                    return 'handled';
                case 'e':
                    this.editor.moveEnd();
                    return 'handled';
                case 'k':
                    this.editor.killToEnd();
                    return 'handled';
                case 'u':
                    this.editor.killToStart();
                    return 'handled';
                case 'w':
                    this.editor.killWordLeft();
                    return 'handled';
                case 'v': {
                    const text = readClipboardSync();
                    if (text) {
                        const clean = String(text).replace(/[\r\n]+/g, '').trim();
                        if (clean)
                            this.editor.insert(clean);
                    }
                    return 'handled';
                }
                default: break;
            }
        }
        // Stay modal for anything unrecognised: a stray key must not reach the
        // input line behind a question that is still open.
        return 'handled';
    }
}
/**
 * The home menu: the action list that sits above the input line.
 *
 * This is deliberately NOT a SelectLayer. A SelectLayer owns the keyboard and
 * filters on every keystroke, which is exactly wrong here — home shows the menu
 * and the chat input in ONE frame, so `↑↓` must pick an action while typing must
 * reach the input line underneath. A filter row would also be a lie: there is
 * nothing to type into it.
 *
 * So this layer claims four keys and hands everything else back:
 *
 *   ↑ ↓     move the selection          → 'handled'
 *   enter   run the selected action     → 'close' (onPick fires first)
 *   esc     put the menu away           → 'close'
 *   else    not mine                    → 'dismiss' for a printable character,
 *                                         'passthrough' for anything else
 *
 * 'dismiss' tears the menu down AND lets the key through, so the first character
 * you type both closes the menu and appears in the input — one keystroke, not
 * two. 'passthrough' leaves the menu up, so ctrl+c, ctrl+p and friends keep
 * working while it is open. Every other Layer returns null and stays modal; the
 * invariant is unchanged for them.
 */
export class HomeLayer extends Layer {
    items;
    index;
    onPick;
    constructor(options = {}) {
        const opts = options && typeof options === 'object' ? options : {};
        super({ width: opts.width || 66, height: opts.height || 14, ...opts });
        this.items = Array.isArray(opts.items) ? [...opts.items] : [];
        this.index = 0;
        this.onPick = opts.onPick || null;
        this.title = opts.title || 'what would you like to do?';
        this.footer = opts.footer || `↑↓ pick  ${GLYPHS.dot}  enter run  ${GLYPHS.dot}  esc menu off  ${GLYPHS.dot}  or just start typing`;
    }
    // No filter row and no rule — one row per item, plus the frame.
    preferredHeight() { return this.items.length + 2; }
    get current() { return this.items[this.index] || null; }
    body(width = 64) {
        // The hint column is right-padded from the widest label so the two columns
        // line up, but it is computed from the ACTUAL labels rather than a constant:
        // a hardcoded inset is what makes a menu look off by one at some widths.
        const cleanItems = this.items.map((item) => ({
            label: cleanDialogText(item?.label || ''),
            hint: cleanDialogText(item?.hint || '')
        }));
        const labelWidth = cleanItems.reduce((max, item) => Math.max(max, visibleWidth(item.label)), 0);
        return cleanItems.map((item, i) => {
            const selected = i === this.index;
            const marker = selected ? paint('accent', GLYPHS.arrow) : ' ';
            const label = selected ? bold(paint('accent', item.label)) : item.label;
            const pad = ' '.repeat(Math.max(0, labelWidth - visibleWidth(item.label)));
            const hint = item.hint ? dim(item.hint) : '';
            // truncate() is ANSI-aware, so styling the label first is safe. The row is
            // clamped to the panel, never to the terminal — the panel is narrower.
            return truncate(` ${marker} ${label}${pad}   ${hint}`, width);
        });
    }
    key(event) {
        if (!event)
            return null;
        switch (event.name) {
            case 'up':
                if (this.items.length === 0)
                    return 'handled';
                this.index = (this.index - 1 + this.items.length) % this.items.length;
                return 'handled';
            case 'down':
                if (this.items.length === 0)
                    return 'handled';
                this.index = (this.index + 1) % this.items.length;
                return 'handled';
            case 'enter':
            case 'return': {
                const item = this.current;
                if (!item)
                    return 'close';
                const result = this.onPick ? this.onPick(item) : null;
                return result === 'keep' ? 'handled' : 'close';
            }
            case 'escape': return 'close';
            default: break;
        }
        // A printable character is the user starting a sentence. Put the menu away
        // and let the character land in the input line in the same keystroke.
        if (event.name === 'char' || event.name === 'paste')
            return 'dismiss';
        // Anything else — ctrl chords, tab, backspace on an empty line — belongs to
        // the prompt, and the menu has no opinion about it.
        return 'passthrough';
    }
}
/**
 * A scrolling text pane — help, usage, an expanded tool output, an error.
 *
 * Takes already-styled rows and scrolls them. It exists so that "show me the
 * whole thing" never again means dumping 900 lines into the transcript.
 */
export class TextLayer extends Layer {
    lines;
    scroll;
    viewHeight;
    constructor(options = {}) {
        const opts = options && typeof options === 'object' ? options : {};
        super({ width: opts.width || 76, height: opts.height || 20, ...opts });
        this.lines = Array.isArray(opts.lines) ? [...opts.lines] : String(opts.text || '').split('\n');
        this.scroll = 0;
        this.footer = opts.footer || `↑↓ scroll  ${GLYPHS.dot}  esc close`;
    }
    preferredHeight() { return this.lines.length + 2; }
    body(width = 72, height = 18) {
        const safeWidth = Number.isFinite(width) && width > 0 ? Math.floor(width) : 8;
        const safeHeight = Number.isFinite(height) && height > 0 ? Math.floor(height) : 1;
        this.viewHeight = safeHeight;
        const maximum = Math.max(0, this.lines.length - safeHeight);
        this.scroll = Math.max(0, Math.min(this.scroll, maximum));
        const windowLines = this.lines.slice(this.scroll, this.scroll + safeHeight)
            .map((line) => truncate(line == null ? '' : safeDisplay(String(line)), safeWidth, GLYPHS.ellipsis));
        if (this.lines.length > safeHeight) {
            const position = `${this.scroll + 1}-${Math.min(this.lines.length, this.scroll + safeHeight)}/${this.lines.length}`;
            while (windowLines.length < safeHeight)
                windowLines.push('');
            windowLines[safeHeight - 1] = dim(position.padStart(safeWidth));
        }
        this.cursor = null;
        return windowLines;
    }
    key(event) {
        if (!event)
            return null;
        const page = Math.max(1, (this.viewHeight || this.height) - 1);
        switch (event.name) {
            case 'escape':
            case 'q': return 'close';
            case 'wheel':
                if (event.wheel?.direction === 'up')
                    this.scroll = Math.max(0, this.scroll - 1);
                else if (event.wheel?.direction === 'down')
                    this.scroll++;
                return 'handled';
            case 'up':
                this.scroll = Math.max(0, this.scroll - 1);
                return 'handled';
            case 'down':
                this.scroll++;
                return 'handled';
            case 'pageup':
                this.scroll = Math.max(0, this.scroll - page);
                return 'handled';
            case 'pagedown':
                this.scroll += page;
                return 'handled';
            case 'home':
                this.scroll = 0;
                return 'handled';
            case 'end':
                this.scroll = this.lines.length;
                return 'handled';
            case 'enter':
            case 'return': return 'close';
            default: return 'handled';
        }
    }
}
/**
 * The approval modal.
 *
 * Answers three questions in one frame, none of which the old prompt answered:
 * how dangerous is this, what exactly will it do, and what will change on disk.
 * The diff scrolls, so a 400-line rewrite is inspectable rather than truncated.
 *
 * The highlighted default is Reject. `y` and `n` remain explicit shortcuts;
 * arrows choose a visible option and Enter commits it. A reflex Enter therefore
 * denies, while an intentional move to either Allow option works consistently.
 */
export class ApprovalLayer extends Layer {
    request;
    detail;
    verb;
    onAnswer;
    scroll;
    risk;
    role;
    capabilityGrant;
    options;
    selected;
    diff;
    optionBounds;
    panelGeometry;
    viewHeight;
    answered;
    constructor(options = {}) {
        const opts = options && typeof options === 'object' ? options : {};
        super({ width: opts.width || 84, height: opts.height || 22, ...opts });
        this.request = opts.request || {};
        this.detail = opts.detail || '';
        this.verb = opts.verb || '';
        this.onAnswer = opts.onAnswer || null;
        this.scroll = 0;
        // The risk TIER is kept for colour and for the audit trail; it is never
        // shown as a word. Printing 'DANGEROUS' at someone who asked to install a
        // package does not make them careful, it makes them numb — and a gate people
        // are numb to is not a gate. opencode shows a warning triangle and the tool,
        // and that is the whole signal: being asked at all IS the warning.
        const risk = String(this.request.risk || 'unknown').toUpperCase();
        this.risk = risk;
        this.role = risk === 'EXTREME' ? 'danger' : risk === 'DANGEROUS' ? 'warn' : 'accent';
        this.title = 'permission required';
        // Selectable options, modelled on opencode's permission prompt: a row of
        // chips moved with ←/→ and committed with enter. Typing y/n still answers
        // directly, so the fast path stays one keystroke rather than two.
        // grant_capability stores consent for the named capability group itself.
        // A standing grant for the *manager tool* would also authorize unrelated
        // package and MCP operations, and adds a redundant second confirmation.
        this.capabilityGrant = this.request.tool === 'manage_local_dependencies'
            && this.request.args?.action === 'grant_capability';
        this.options = [
            { id: 'once', label: 'Allow once', answer: true },
            // Standing approval for the rest of the PROCESS — never written to disk.
            // Seven developers in ten would rather grant this than be asked again,
            // and a gate people hammer through is worse than one they chose to lift.
            // It is not the default and it is confirmed a second time before it takes
            // effect; see makeApprovalHandler in cliMode.js.
            ...(!this.capabilityGrant ? [{ id: 'always', label: 'Allow always', answer: true }] : []),
            { id: 'reject', label: 'Reject', answer: false }
        ];
        // THE DEFAULT IS DENY, AND THAT IS DELIBERATE.
        //
        // opencode starts on its approving option, which suits a coding session
        // where the worst case is an unwanted file edit. Causyne's approval gate
        // also stands in front of `sysRun` and `desktop_act` — arbitrary shell and
        // full control of the user's mouse and keyboard. Enter is the key people
        // press without reading, so it must not be the one that says yes.
        //
        // Approving is still a single keystroke (`y`); it is just not the REFLEX
        // keystroke. Set the highlight to Approve here and one careless enter
        // authorises anything the agent asks for.
        this.selected = this.options.findIndex(option => option.id === 'reject');
        this.footer = `←→ choose  ${GLYPHS.dot}  enter confirm  ${GLYPHS.dot}  ${this.capabilityGrant ? 'y/n' : 'y/a/n'} direct  ${GLYPHS.dot}  ↑↓ scroll  ${GLYPHS.dot}  esc reject`;
        this.diff = approvalDiff(this.request.tool, this.request.args, { width: this.width - 6, maxLines: 400 });
    }
    preferredHeight() {
        const detailRows = this.detail ? 1 : 0;
        // A diff costs a blank, a stat row and a rule on top of its own rows.
        const diffRows = this.diff ? this.diff.rows.length + 3 : Object.keys(this.request.args || {}).length + 1;
        // +2 for the blank line and the option row that always sit at the bottom.
        return 1 + detailRows + diffRows + 2 + 2;
    }
    /** The chip row: the selected option is filled, the rest are dimmed. */
    optionRow() {
        let col = 0;
        this.optionBounds = [];
        const parts = this.options.map((option, index) => {
            const rendered = index === this.selected
                ? badge(option.id === 'reject' ? 'danger' : 'success', option.label)
                : dim(`  ${option.label}  `);
            const width = visibleWidth(rendered);
            this.optionBounds.push({ index, option, startCol: col, endCol: col + width - 1 });
            col += width + 1;
            return rendered;
        });
        return parts.join(' ');
    }
    body(width = 80, fullHeight = 20) {
        // Two rows are reserved at the bottom for the blank line and the option
        // chips, so the diff never grows into the controls and push them off-panel.
        const height = Math.max(1, fullHeight - 2);
        const rows = [];
        const cleanVerb = this.verb ? cleanDialogText(this.verb) : '';
        rows.push(`${paint(this.role, GLYPHS.warnMark)} ${bold(safeDisplay(this.request.tool || ''))}${cleanVerb ? dim(`  ${cleanVerb}`) : ''}`);
        if (this.detail) {
            for (const line of wrap(paint('ink', cleanDialogText(this.detail)), width).slice(0, 2))
                rows.push(line);
        }
        if (this.diff) {
            const stat = [
                this.diff.added ? paint('success', `+${this.diff.added}`) : '',
                this.diff.removed ? paint('danger', `-${this.diff.removed}`) : ''
            ].filter(Boolean).join(' ');
            const note = this.diff.note ? dim(`  ${GLYPHS.dot}  ${cleanDialogText(this.diff.note)}`) : '';
            // The detail row above already names the file; printing the path again
            // here just spends a row saying the same thing twice.
            const where = this.detail ? '' : `${dim(cleanDialogText(this.diff.path))}  `;
            rows.push('');
            rows.push(`${where}${stat}${note}`);
            rows.push(paint('rule', GLYPHS.hLine.repeat(width)));
            // Only spend a row on the scroll indicator when there is actually
            // something out of view. Reserving it unconditionally cost one diff row
            // on every dialog that fit perfectly.
            const available = Math.max(1, height - rows.length);
            const needsIndicator = this.diff.rows.length > available;
            const room = needsIndicator ? Math.max(1, available - 1) : available;
            this.viewHeight = room;
            const maximum = Math.max(0, this.diff.rows.length - room);
            this.scroll = Math.max(0, Math.min(this.scroll, maximum));
            for (const line of this.diff.rows.slice(this.scroll, this.scroll + room)) {
                rows.push(truncate(line, width, GLYPHS.ellipsis));
            }
            if (this.diff.rows.length > room) {
                rows.push(dim(`${this.scroll + 1}-${Math.min(this.diff.rows.length, this.scroll + room)}/${this.diff.rows.length}`.padStart(width)));
            }
        }
        else if (this.request.args) {
            rows.push('');
            // No diff means this is not a file mutation; show the arguments instead,
            // because "approve sysRun" with the command hidden is not consent either.
            for (const [key, value] of Object.entries(this.request.args).slice(0, 8)) {
                const shown = typeof value === 'string' ? shortenHome(value) : safeJsonPreview(value);
                for (const line of wrap(`${paint('muted', key)}  ${paint('ink', safeDisplay(String(shown)))}`, width).slice(0, 4)) {
                    rows.push(line);
                    if (rows.length >= height)
                        break;
                }
                if (rows.length >= height)
                    break;
            }
        }
        while (rows.length < height)
            rows.push('');
        rows.push('');
        rows.push(this.optionRow());
        this.cursor = null;
        return rows.slice(0, fullHeight);
    }
    key(event) {
        if (!event)
            return null;
        const page = Math.max(1, (this.viewHeight || 8) - 1);
        // isChar(), NOT event.name. A printable key decodes to {name:'char',
        // text:'y'} — only MODIFIED letters carry the letter as a name. Testing
        // event.name === 'y' here matched ctrl+y and never matched y, so this
        // dialog could not be approved at all; escape worked, which made it look
        // responsive. See src/tui/keys.js isChar().
        if (isChar(event, 'y')) {
            this.answer(true, 'once');
            return 'close';
        }
        if (!this.capabilityGrant && isChar(event, 'a')) {
            this.answer(true, 'always');
            return 'close';
        }
        if (isChar(event, 'n')) {
            this.answer(false, 'reject');
            return 'close';
        }
        if (event.name === 'escape') {
            this.answer(false, 'reject');
            return 'close';
        }
        // ←/→ move the highlight, enter commits it — opencode's permission model,
        // which is the one people already have muscle memory for. `h`/`l` come
        // along for the same reason opencode binds them: a vim user reaches for
        // them without thinking, and they cost nothing here.
        const move = (delta) => {
            this.selected = (this.selected + delta + this.options.length) % this.options.length;
            return 'handled';
        };
        if (event.name === 'left' || isChar(event, 'h'))
            return move(-1);
        if (event.name === 'right' || isChar(event, 'l'))
            return move(1);
        if (event.name === 'enter' || event.name === 'return') {
            const choice = this.options[this.selected];
            this.answer(Boolean(choice && choice.answer), choice ? choice.id : 'reject');
            return 'close';
        }
        if (event.name === 'mouse' && event.mouse && event.mouse.pressed && event.mouse.button === 0 && !isMouseMotion(event.sequence)) {
            if (!Array.isArray(this.optionBounds) || this.optionBounds.length === 0) {
                this.optionRow();
            }
            const geom = this.panelGeometry;
            const hasZeroRow = Number.isFinite(event.mouse.y);
            const rawRow = hasZeroRow
                ? Math.floor(event.mouse.y)
                : (Number.isFinite(event.mouse.row) ? Math.floor(event.mouse.row) : Number.NaN);
            if (geom && Number.isFinite(rawRow) && typeof geom.optionScreenRow === 'number' && Number.isFinite(geom.optionScreenRow)) {
                // drawLayer() computes 0-based screen rows; legacy synthetic callers send 1-based row.
                const zeroBasedRow = hasZeroRow ? rawRow : rawRow - 1;
                if (Math.abs(zeroBasedRow - geom.optionScreenRow) > 1)
                    return 'handled';
            }
            const hasZeroCol = Number.isFinite(event.mouse.x);
            const rawCol = hasZeroCol
                ? Math.floor(event.mouse.x)
                : (Number.isFinite(event.mouse.col) ? Math.floor(event.mouse.col) : -1);
            const bodyCol = geom
                ? rawCol - (hasZeroCol ? 0 : 1) - (geom.inset || 0) - 2
                : rawCol;
            const hit = (this.optionBounds || []).find(b => bodyCol >= b.startCol && bodyCol <= b.endCol);
            if (hit) {
                this.selected = hit.index;
                this.answer(Boolean(hit.option.answer), hit.option.id);
                return 'close';
            }
            return 'handled';
        }
        if (event.name === 'wheel') {
            if (event.wheel?.direction === 'up')
                this.scroll = Math.max(0, this.scroll - 1);
            else if (event.wheel?.direction === 'down')
                this.scroll++;
            return 'handled';
        }
        switch (event.name) {
            case 'up':
                this.scroll = Math.max(0, this.scroll - 1);
                return 'handled';
            case 'down':
                this.scroll++;
                return 'handled';
            case 'pageup':
                this.scroll = Math.max(0, this.scroll - page);
                return 'handled';
            case 'pagedown':
                this.scroll += page;
                return 'handled';
            case 'home':
                this.scroll = 0;
                return 'handled';
            case 'end':
                this.scroll = this.diff ? this.diff.rows.length : 0;
                return 'handled';
            default: return 'handled';
        }
    }
    /**
     * Deliver the decision exactly once.
     *
     * `scope` says WHICH option produced it — 'once', 'always' or 'reject'.
     * closeLayer() calls this with no arguments when a dialog is torn down from
     * outside, and the defaults make that a rejection, which is the safe reading
     * of a question nobody answered.
     */
    answer(approved = false, scope = 'reject') {
        if (this.answered)
            return;
        this.answered = true;
        if (this.onAnswer)
            this.onAnswer(approved, scope);
    }
}
/** A structured product or architecture choice, separate from permissions. */
export class DecisionLayer extends Layer {
    request;
    onAnswer;
    options;
    selected;
    customIndex;
    customMode;
    editor;
    answered;
    constructor(options = {}) {
        const opts = options && typeof options === 'object' ? options : {};
        super({ width: opts.width || 82, height: opts.height || 24, ...opts });
        this.request = opts.request || {};
        this.onAnswer = opts.onAnswer || null;
        this.options = Array.isArray(this.request.options) ? this.request.options.slice(0, 4) : [];
        this.selected = 0;
        this.customIndex = this.options.length;
        this.customMode = false;
        this.editor = new LineEditor();
        this.answered = false;
        this.title = safeDisplay(this.request.header || 'decision required');
        this.footer = `↑↓ choose  ${GLYPHS.dot}  enter select  ${GLYPHS.dot}  esc cancel`;
    }
    preferredHeight() {
        const questionRows = wrap(safeDisplay(this.request.question || ''), Math.max(20, this.width - 6)).length;
        const reasonRows = wrap(safeDisplay(this.request.reason || ''), Math.max(20, this.width - 6)).length;
        return Math.min(this.height, questionRows + reasonRows + (this.options.length * 2) + 7);
    }
    body(width = 78, height = 22) {
        const rows = [];
        rows.push(...wrap(bold(safeDisplay(this.request.question || 'Choose a direction')), width).slice(0, 4));
        if (this.request.reason)
            rows.push(...wrap(dim(safeDisplay(this.request.reason)), width).slice(0, 3));
        rows.push('');
        for (const [index, option] of this.options.entries()) {
            const selected = index === this.selected;
            const marker = selected ? paint('accent', GLYPHS.arrow) : paint('muted', GLYPHS.dot);
            rows.push(`${marker} ${selected ? bold(safeDisplay(option.label || '')) : safeDisplay(option.label || '')}`);
            if (option.description)
                rows.push(`  ${dim(truncate(safeDisplay(option.description), Math.max(1, width - 2), GLYPHS.ellipsis))}`);
        }
        const safeWidth = Number.isFinite(width) && width > 0 ? Math.floor(width) : 8;
        const safeHeight = Number.isFinite(height) && height > 0 ? Math.floor(height) : rows.length + 2;
        const customSelected = this.selected === this.customIndex;
        rows.push(`${customSelected ? paint('accent', GLYPHS.arrow) : paint('muted', GLYPHS.dot)} ${customSelected ? bold('Type your own answer') : 'Type your own answer'}`);
        if (this.customMode) {
            const raw = this.editor.getText();
            const value = cleanDialogText(raw);
            rows.push(truncate(`${paint('accent', `${GLYPHS.arrow} `)}${value || dim('Describe the direction you want')}`, safeWidth, GLYPHS.ellipsis));
            const rendered = rows.length > safeHeight ? rows.slice(rows.length - safeHeight) : rows;
            const before = visibleWidth(cleanDialogText(raw.slice(0, this.editor.col)));
            this.cursor = {
                x: Math.min(Math.max(0, safeWidth - 1), 2 + before),
                y: Math.max(0, rendered.length - 1)
            };
            this.footer = `enter submit  ${GLYPHS.dot}  esc choices`;
            return rendered;
        }
        else {
            this.cursor = null;
            this.footer = `↑↓ choose  ${GLYPHS.dot}  enter select  ${GLYPHS.dot}  esc cancel`;
        }
        return rows.slice(0, safeHeight);
    }
    key(event) {
        if (!event)
            return null;
        if (this.customMode) {
            if (event.name === 'escape') {
                this.customMode = false;
                return 'handled';
            }
            if (event.name === 'enter' || event.name === 'return') {
                const label = this.editor.getText().replace(/\s+/g, ' ').trim();
                if (!label)
                    return 'handled';
                this.answer({ requestId: this.request.id, optionId: null, label, custom: true });
                return 'close';
            }
            if (event.name === 'backspace') {
                this.editor.backspace();
                return 'handled';
            }
            if (event.name === 'delete') {
                this.editor.deleteForward();
                return 'handled';
            }
            if (event.name === 'left') {
                this.editor.moveLeft();
                return 'handled';
            }
            if (event.name === 'right') {
                this.editor.moveRight();
                return 'handled';
            }
            if (event.name === 'home') {
                this.editor.moveHome();
                return 'handled';
            }
            if (event.name === 'end') {
                this.editor.moveEnd();
                return 'handled';
            }
            if (event.name === 'paste') {
                this.editor.insert(event.text);
                return 'handled';
            }
            if (event.name === 'char') {
                this.editor.insert(event.text);
                return 'handled';
            }
            return 'handled';
        }
        if (event.name === 'escape') {
            this.answer(null);
            return 'close';
        }
        const count = this.options.length + 1;
        if (event.name === 'up') {
            this.selected = (this.selected - 1 + count) % count;
            return 'handled';
        }
        if (event.name === 'down') {
            this.selected = (this.selected + 1) % count;
            return 'handled';
        }
        if (event.name === 'enter' || event.name === 'return') {
            if (this.selected === this.customIndex) {
                this.customMode = true;
                return 'handled';
            }
            const option = this.options[this.selected];
            if (!option)
                return 'handled';
            this.answer({ requestId: this.request.id, optionId: option.id, label: option.label, custom: false });
            return 'close';
        }
        return 'handled';
    }
    answer(value = null) {
        if (this.answered)
            return;
        this.answered = true;
        if (this.onAnswer)
            this.onAnswer(value);
    }
}
/** A yes/no confirm, for destructive commands that are not tool approvals. */
export class ConfirmLayer extends Layer {
    message;
    onAnswer;
    defaultAnswer;
    settled;
    constructor(options = {}) {
        const opts = options && typeof options === 'object' ? options : {};
        super({ width: opts.width || 60, height: opts.height || 8, ...opts });
        this.message = opts.message || 'Are you sure?';
        this.onAnswer = opts.onAnswer || null;
        this.defaultAnswer = opts.defaultAnswer === true;
        this.footer = this.defaultAnswer
            ? `enter confirm  ${GLYPHS.dot}  y yes  ${GLYPHS.dot}  n no  ${GLYPHS.dot}  esc cancel`
            : `enter cancel  ${GLYPHS.dot}  y yes  ${GLYPHS.dot}  n no  ${GLYPHS.dot}  esc cancel`;
        this.settled = false;
    }
    /**
     * Dismissal is an ANSWER, and the safe answer is no.
     *
     * ChatPrompt.closeLayer() calls this on any layer that defines it. Without it
     * a confirm torn down from outside — an interrupt, a resize teardown, the
     * host stopping — left its promise pending forever and hung the caller
     * mid-approval. The `settled` guard is what makes the y/n path and this path
     * safe to both fire.
     */
    answer(value = false) {
        if (this.settled)
            return;
        this.settled = true;
        if (this.onAnswer)
            this.onAnswer(Boolean(value));
    }
    preferredHeight() { return 6; }
    body(width = 56) {
        this.cursor = null;
        return ['', ...wrap(paint('ink', safeDisplay(this.message)), width)];
    }
    key(event) {
        if (!event)
            return null;
        // `y` is always an explicit approval. Enter follows the default selected by
        // the caller: false for ordinary destructive confirmations, true only for
        // the second step after the user has already selected Allow always.
        if (isChar(event, 'y')) {
            this.answer(true);
            return 'close';
        }
        if (isChar(event, 'n') || event.name === 'escape') {
            this.answer(false);
            return 'close';
        }
        if (event.name === 'enter' || event.name === 'return') {
            this.answer(this.defaultAnswer);
            return 'close';
        }
        return 'handled';
    }
}
/** The command palette — every command in the app, fuzzy-searchable. */
export function commandPalette(commands, onRun) {
    const safeCommands = Array.isArray(commands) ? commands.filter(Boolean) : [];
    return new SelectLayer({
        title: 'commands',
        placeholder: 'search commands',
        emptyText: 'no command matches',
        width: 72,
        height: 20,
        items: safeCommands.map((command) => ({
            label: cleanDialogText(command.name || ''),
            description: cleanDialogText(command.description || ''),
            category: cleanDialogText(command.category || ''),
            hint: cleanDialogText(command.hint || ''),
            searchText: cleanDialogText(command.description || ''),
            value: command
        })),
        onPick: (item) => { if (item && onRun)
            onRun(item.value); }
    });
}
/**
 * The skill browser: 100 skills, fuzzy-searchable, grouped by domain.
 *
 * `/skills` used to print every skill as one unwrapped line. At five skills that
 * was merely ugly — descriptions reached 195 columns on a 102-column terminal
 * and the terminal broke them mid-word at column 0. At 100 it would be a wall of
 * text nobody reads. Both references browse skills in a picker instead
 * (opencode's dialog-skill.tsx), and the picker truncates each description to
 * the pane rather than to the terminal, so overflow is structurally impossible.
 */
export function skillPicker(skills, onOpen) {
    const safeSkills = Array.isArray(skills) ? skills.filter(Boolean) : [];
    return new SelectLayer({
        title: `skills (${safeSkills.length})`,
        placeholder: 'search skills',
        emptyText: 'no skill matches',
        width: 76,
        height: 22,
        items: safeSkills.map((skill) => ({
            label: `${cleanDialogText(skill.domain || '')}/${cleanDialogText(skill.id || '')}`,
            description: cleanDialogText(skill.description || ''),
            category: cleanDialogText(skill.domain || ''),
            searchText: cleanDialogText(`${skill.name || ''} ${skill.description || ''}`),
            value: skill
        })),
        onPick: (item) => { if (item && onOpen)
            onOpen(item.value); }
    });
}
/** Help: the keys, grouped, in a scrolling pane. */
export function helpLayer(sections) {
    const safeSections = Array.isArray(sections) ? sections.filter(Boolean) : [];
    const lines = [];
    for (const section of safeSections) {
        lines.push(bold(paint('ink', cleanDialogText(section.title || ''))));
        const rows = Array.isArray(section.rows) ? section.rows : [];
        for (const pair of rows) {
            if (!Array.isArray(pair))
                continue;
            const keys = cleanDialogText(pair[0] || '');
            const what = cleanDialogText(pair[1] || '');
            lines.push(`  ${paint('accent', keys.padEnd(18))}${dim(what)}`);
        }
        lines.push('');
    }
    return new TextLayer({ title: 'keys', lines, width: 62, height: Math.min(24, lines.length + 3) });
}
/** A status pane: session facts that would otherwise need a scrollback hunt. */
export function statusLayer(rows) {
    const safeRows = (Array.isArray(rows) ? rows : []).filter((row) => Array.isArray(row));
    const labels = safeRows.map(row => cleanDialogText(row[0] == null ? '' : String(row[0])));
    const width = labels.reduce((max, label) => Math.max(max, label.length), 0);
    const lines = safeRows.map((row, index) => {
        const label = labels[index] ?? '';
        const value = cleanDialogText(row[1] == null ? '' : String(row[1]));
        return label === ''
            ? ''
            : `${paint('muted', label.padEnd(width + 2))}${paint('ink', value)}`;
    });
    return new TextLayer({ title: 'session', lines, width: 74, height: Math.min(24, lines.length + 3) });
}
export { visibleWidth };
