import { paint, bold as themeBold, dim as themeDim, GLYPHS, HAS_COLOR, terminalWidth } from '../tui/theme.js';
import { visibleWidth, truncate, padEnd, safeDisplay } from '../tui/text.js';

export interface SpinnerHandle {
  start(): SpinnerHandle;
  stop(successText?: string): void;
  fail(errorText?: string): void;
}

export interface UIInterface {
  colors: Record<string, string>;
  box: Record<string, string>;
  printHeader(title: string, subtitle?: string): void;
  printCard(title: string, bodyLines: string | string[], highlight?: boolean): void;
  printSuccess(msg: string): void;
  printInfo(msg: string): void;
  printWarning(msg: string): void;
  printError(msg: string): void;
  printFatalBox(title: string, lines: string[]): void;
  createSpinner(text: string): SpinnerHandle;
}

const ESC = '\x1b';
const RESET = HAS_COLOR ? `${ESC}[0m` : '';
const CLEAR_EOL = `${ESC}[K`;

function openRole(role: string): string {
  if (!HAS_COLOR) return '';
  const painted = paint(role, ' ');
  const marker = painted.indexOf(' ');
  return marker === -1 ? '' : painted.slice(0, marker);
}

const COLORS: Record<string, string> = {
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

const BOX: Record<string, string> = {
  tl: GLYPHS.topLeft, tr: GLYPHS.topRight,
  bl: GLYPHS.bottomLeft, br: GLYPHS.bottomRight,
  h: GLYPHS.hLine, v: GLYPHS.vLine,
  l: GLYPHS.tee, r: GLYPHS.tee
};

function cardWidth(lines: readonly string[], title: string): number {
  const content = lines.reduce((max, line) => Math.max(max, visibleWidth(line)), visibleWidth(title || ''));
  return Math.max(46, Math.min(content + 4, Math.max(20, terminalWidth() - 4)));
}

class Spinner implements SpinnerHandle {
  text: string;
  frames: readonly string[];
  index: number;
  timer: ReturnType<typeof setInterval> | null;
  live: boolean;

  constructor(text: string) {
    this.text = text;
    this.frames = GLYPHS.spinner;
    this.index = 0;
    this.timer = null;
    this.live = Boolean(process.stdout.isTTY);
  }

  start(): SpinnerHandle {
    if (!this.live) {
      process.stdout.write(`  ${this.text}\n`);
      return this;
    }
    this.timer = setInterval(() => {
      this.index = (this.index + 1) % this.frames.length;
      process.stdout.write(`\r  ${paint('accent', this.frames[this.index] ?? '*')} ${this.text}${CLEAR_EOL}`);
    }, 80);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return this;
  }

  end(glyph: string, role: string, text?: string): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const line = `  ${paint(role, glyph)} ${text || this.text}`;
    process.stdout.write(this.live ? `\r${line}${CLEAR_EOL}\n` : `${line}\n`);
  }

  stop(successText?: string): void { this.end(GLYPHS.check, 'success', successText); }
  fail(errorText?: string): void { this.end(GLYPHS.cross, 'danger', errorText); }
}

export const UI: UIInterface = {
  colors: COLORS,
  box: BOX,

  printHeader(title: string, subtitle?: string): void {
    const safeTitle = safeDisplay(String(title ?? ''));
    const safeSub = subtitle ? safeDisplay(String(subtitle)) : '';
    console.log('');
    console.log(`  ${themeBold(paint('accent', safeTitle))}${safeSub ? themeDim(`  ${GLYPHS.dot}  ${safeSub}`) : ''}`);
    console.log(themeDim(`  ${GLYPHS.hLine.repeat(Math.max(10, Math.min(60, terminalWidth() - 4)))}`));
  },

  printCard(title: string, bodyLines: string | string[], highlight = false): void {
    const lines = Array.isArray(bodyLines) ? bodyLines : [String(bodyLines)];
    const width = cardWidth(lines, title);
    const inner = width - 2;
    const role = highlight ? 'accent' : 'rule';

    const label = title ? ` ${title} ` : '';
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

  printSuccess(msg: string): void { console.log(`  ${paint('success', GLYPHS.check)} ${msg}`); },
  printInfo(msg: string): void { console.log(`  ${paint('accent', GLYPHS.bullet)} ${msg}`); },
  printWarning(msg: string): void { console.log(`  ${paint('warn', GLYPHS.bullet)} ${msg}`); },
  printError(msg: string): void { console.log(`  ${paint('danger', GLYPHS.cross)} ${msg}`); },

  printFatalBox(title: string, lines: string[]): void {
    const safeLines = Array.isArray(lines) ? lines : [String(lines)];
    const width = cardWidth(safeLines, title);
    const inner = width - 2;
    const edge = (l: string, r: string): void => console.log(`  ${paint('danger', l + (BOX.h ?? '-').repeat(inner) + r)}`);
    const row = (text: string): void => console.log(`  ${paint('danger', BOX.v ?? '|')} ${padEnd(truncate(text, inner - 2, GLYPHS.ellipsis), inner - 2)} ${paint('danger', BOX.v ?? '|')}`);
    console.log('');
    edge(BOX.tl ?? '+', BOX.tr ?? '+');
    row(themeBold(paint('danger', title)));
    edge(BOX.l ?? '+', BOX.r ?? '+');
    for (const line of safeLines) row(line);
    edge(BOX.bl ?? '+', BOX.br ?? '+');
    console.log('');
  },

  createSpinner(text: string): SpinnerHandle { return new Spinner(text); }
};

export default UI;
