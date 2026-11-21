import { paint, bold as themeBold, dim as themeDim, GLYPHS, HAS_COLOR, terminalWidth } from '../tui/theme.js';
import { visibleWidth, truncate, padEnd, safeDisplay } from '../tui/text.js';
const ESC = '\x1b';
const RESET = HAS_COLOR ? `${ESC}[0m` : '';
const CLEAR_EOL = `${ESC}[K`;
function openRole(role) {
    if (!HAS_COLOR)
        return '';
    const painted = paint(role, ' ');
    const marker = painted.indexOf(' ');
    return marker === -1 ? '' : painted.slice(0, marker);
}
const COLORS = {
    blue: openRole('accent'),
    dimGray: openRole('muted'),
    white: openRole('ink'),
    red: openRole('danger'),
    green: openRole('success'),
    yellow: openRole('warn'),
    reset: RESET,
    bold: HAS_COLOR ? `${ESC}[1m` : '',
    dim: HAS_COLOR ? `${ESC}[2m` : ''
};
const BOX = {
    tl: GLYPHS.topLeft, tr: GLYPHS.topRight,
    bl: GLYPHS.bottomLeft, br: GLYPHS.bottomRight,
    h: GLYPHS.hLine, v: GLYPHS.vLine,
    l: GLYPHS.tee, r: GLYPHS.tee
};
function cardWidth(lines, title) {
    const content = lines.reduce((max, line) => Math.max(max, visibleWidth(line)), visibleWidth(title || ''));
    return Math.max(46, Math.min(content + 4, Math.max(20, terminalWidth() - 4)));
}
class Spinner {
    text;
    frames;
    index;
    timer;
    live;
    constructor(text) {
        this.text = text;
        this.frames = GLYPHS.spinner;
        this.index = 0;
        this.timer = null;
        this.live = Boolean(process.stdout.isTTY);
    }
    start() {
        if (!this.live) {
            process.stdout.write(`  ${this.text}\n`);
            return this;
        }
        this.timer = setInterval(() => {
            this.index = (this.index + 1) % this.frames.length;
            process.stdout.write(`\r  ${paint('accent', this.frames[this.index] ?? '*')} ${this.text}${CLEAR_EOL}`);
        }, 80);
        if (typeof this.timer.unref === 'function')
            this.timer.unref();
        return this;
    }
    end(glyph, role, text) {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        const line = `  ${paint(role, glyph)} ${text || this.text}`;
        process.stdout.write(this.live ? `\r${line}${CLEAR_EOL}\n` : `${line}\n`);
    }
    stop(successText) { this.end(GLYPHS.check, 'success', successText); }
    fail(errorText) { this.end(GLYPHS.cross, 'danger', errorText); }
}
export const UI = {
    colors: COLORS,
    box: BOX,
    printHeader(title, subtitle) {
        const safeTitle = safeDisplay(String(title ?? ''));
        const safeSub = subtitle ? safeDisplay(String(subtitle)) : '';
        console.log('');
        console.log(`  ${themeBold(paint('accent', safeTitle))}${safeSub ? themeDim(`  ${GLYPHS.dot}  ${safeSub}`) : ''}`);
        console.log(themeDim(`  ${GLYPHS.hLine.repeat(Math.max(10, Math.min(60, terminalWidth() - 4)))}`));
    },
    printCard(title, bodyLines, highlight = false) {
        const safeTitle = safeDisplay(String(title ?? ''));
        const rawLines = Array.isArray(bodyLines) ? bodyLines : [String(bodyLines ?? '')];
        const lines = rawLines.map(line => safeDisplay(String(line ?? '')));
        const width = cardWidth(lines, safeTitle);
        const inner = width - 2;
        const role = highlight ? 'accent' : 'rule';
        const label = safeTitle ? ` ${safeTitle} ` : '';
        const trail = (BOX.h ?? '-').repeat(Math.max(0, inner - visibleWidth(label) - 1));
        console.log('');
        console.log(`  ${paint(role, (BOX.tl ?? '+') + (BOX.h ?? '-'))}${paint('accent', label)}${paint(role, trail + (BOX.tr ?? '+'))}`);
        for (const line of lines) {
            const cell = visibleWidth(line) > inner - 2 ? truncate(line, inner - 2, GLYPHS.ellipsis) : line;
            console.log(`  ${paint(role, BOX.v ?? '|')} ${padEnd(cell, inner - 2)} ${paint(role, BOX.v ?? '|')}`);
        }
        console.log(`  ${paint(role, (BOX.bl ?? '+') + (BOX.h ?? '-').repeat(inner) + (BOX.br ?? '+'))}`);
        console.log('');
    },
    printSuccess(msg) { console.log(`  ${paint('success', GLYPHS.check)} ${safeDisplay(String(msg ?? ''))}`); },
    printInfo(msg) { console.log(`  ${paint('accent', GLYPHS.bullet)} ${safeDisplay(String(msg ?? ''))}`); },
    printWarning(msg) { console.log(`  ${paint('warn', GLYPHS.bullet)} ${safeDisplay(String(msg ?? ''))}`); },
    printError(msg) { console.log(`  ${paint('danger', GLYPHS.cross)} ${safeDisplay(String(msg ?? ''))}`); },
    printFatalBox(title, lines) {
        const safeLines = Array.isArray(lines) ? lines : [String(lines)];
        const width = cardWidth(safeLines, title);
        const inner = width - 2;
        const edge = (l, r) => console.log(`  ${paint('danger', l + (BOX.h ?? '-').repeat(inner) + r)}`);
        const row = (text) => console.log(`  ${paint('danger', BOX.v ?? '|')} ${padEnd(truncate(text, inner - 2, GLYPHS.ellipsis), inner - 2)} ${paint('danger', BOX.v ?? '|')}`);
        console.log('');
        edge(BOX.tl ?? '+', BOX.tr ?? '+');
        row(themeBold(paint('danger', title)));
        edge(BOX.l ?? '+', BOX.r ?? '+');
        for (const line of safeLines)
            row(line);
        edge(BOX.bl ?? '+', BOX.br ?? '+');
        console.log('');
    },
    createSpinner(text) { return new Spinner(text); }
};
export default UI;
