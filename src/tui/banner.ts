/**
 * Canonical Causyne Agent terminal identity: aperture, pixel wordmark, status,
 * and adaptive fallbacks. TypeScript is the source; the repository build emits
 * the readable ESM file imported by the CLI.
 *
 * Environment: NO_COLOR, CAUSYNE_NO_COLOR, FORCE_COLOR=1|2|3,
 * CAUSYNE_ASCII=1 (7-bit only), and CAUSYNE_NO_ANIM=1.
 */
import { homedir } from 'node:os';

export type ColorMode = 'truecolor' | '256' | '16' | 'none';
export type Variant = 'full' | 'compact' | 'mini';

export interface BannerInfo {
  version?: string;
  provider?: string;
  model?: string;
  mode?: string;
  cwd?: string;
  autonomyMode?: string;
  tier?: string;
  workspace?: string;
}
export interface BannerOptions extends BannerInfo {
  /** 'auto' picks from the terminal size: full >= 80x24, compact >= 44 cols, otherwise mini. */
  variant?: Variant | 'auto';
  /** 'auto' honours NO_COLOR / FORCE_COLOR / TTY / COLORTERM. */
  color?: ColorMode | 'auto' | boolean;
  unicode?: boolean; width?: number; height?: number;
  /** Which blade is lime (0-5, clockwise from top-right). Used by the boot animation. */
  active?: number;
  animate?: boolean; frameMs?: number;
  /** Print even when stdout is not a TTY. */
  force?: boolean;
}
export interface TermStream { isTTY?: boolean; columns?: number; rows?: number; getColorDepth?: () => number; write(chunk: string): unknown }
export interface Caps { tty: boolean; width: number; height: number; color: ColorMode; unicode: boolean; variant: Variant }

type Key = 'lime' | 'gray' | 'white' | 'dim';
type Px = Key | null;
type Canvas = Px[][];
type Font = Record<string, readonly string[]>;
type RGB = readonly [number, number, number];

export const TAGLINE = 'From intention to meaningful progress.';

// ---- Logo -----------------------------------------------------------------------------------------------
// One character = one "pixel". A terminal cell holds two stacked pixels (drawn with the half blocks ▀ ▄ █).
// '.' is empty, 0-5 is the blade id. Blade 0 is the lime one (top-right); ids run clockwise.
const LOGO_L: readonly string[] = [
  '......................',
  '.........5555.........',
  '.......555555.........',
  '.....5555555.0000.....',
  '....5555555.0000000...',
  '...5555555.000000000..',
  '....55555.00000000000.',
  '.44.5555.......000000.',
  '.444.55...........000.',
  '.444..5........111..0.',
  '.4444..........11111..',
  '.4444...........11111.',
  '.44444...........1111.',
  '.444444..........1111.',
  '..44444........2..111.',
  '......4........22.111.',
  '.3333.........222..11.',
  '.33333333333.22222.11.',
  '..333333333.2222222...',
  '....333333.2222222....',
  '.....3333.2222222.....',
  '.........222222.......',
  '.........2222.........',
  '......................',
];
const LOGO_S: readonly string[] = [
  '..................',
  '.......555........',
  '.....55555..0.....',
  '...555555.00000...',
  '...55555.0000000..',
  '.4.5555..00000000.',
  '.44.55.......0000.',
  '.44.55......1...0.',
  '.444........1111..',
  '.444.........1111.',
  '.4444.........111.',
  '.44444........111.',
  '...444......22.11.',
  '.33.........22.11.',
  '.333333333.2222.1.',
  '..3333333.22222...',
  '...33333.222222...',
  '.....33.22222.....',
  '........222.......',
  '..................',
];

// ---- Wordmark: pixel fonts ('#' = lit pixel). CAUSYNE is 6x7, AGENT is 5x5. The A has no crossbar, like the brand wordmark.
const F7: Font = {
  C: ['.####.', '#....#', '#.....', '#.....', '#.....', '#....#', '.####.'],
  A: ['..##..', '.#..#.', '.#..#.', '#....#', '#....#', '#....#', '#....#'],
  U: ['#....#', '#....#', '#....#', '#....#', '#....#', '#....#', '.####.'],
  S: ['.#####', '#.....', '#.....', '.####.', '.....#', '.....#', '#####.'],
  Y: ['#....#', '.#..#.', '..##..', '..##..', '..##..', '..##..', '..##..'],
  N: ['#....#', '##...#', '#.#..#', '#..#.#', '#...##', '#....#', '#....#'],
  E: ['######', '#.....', '#.....', '####..', '#.....', '#.....', '######'],
};
const F5: Font = {
  A: ['..#..', '.#.#.', '.#.#.', '#...#', '#...#'],
  G: ['.####', '#....', '#.###', '#...#', '.###.'],
  E: ['#####', '#....', '###..', '#....', '#####'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..'],
};

// ---- Colour ---------------------------------------------------------------------------------------------
const ESC = '\x1b[';
const RESET = ESC + '0m';
const PAL: Record<Key, RGB> = { lime: [182, 224, 111], gray: [95, 102, 114], white: [244, 246, 248], dim: [140, 148, 160] };
const C16: Record<Key, number> = { lime: 92, gray: 90, white: 97, dim: 90 };
const STRONG: Record<Key, boolean> = { lime: true, white: true, gray: false, dim: false };
const LV = [0, 95, 135, 175, 215, 255] as const;
const FORCE: Record<string, ColorMode> = { '0': 'none', false: 'none', '1': '16', true: '16', '2': '256', '3': 'truecolor' };

function to256(c: RGB): number {
  const [r, g, b] = c;
  const near = (v: number): number => LV.reduce<number>((bi, x, i) => (Math.abs(x - v) < Math.abs((LV[bi] ?? 0) - v) ? i : bi), 0);
  const ri = near(r), gi = near(g), bi = near(b), cube = 16 + 36 * ri + 6 * gi + bi;
  const gl = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10))), gv = 8 + 10 * gl;
  const dc = (r - (LV[ri] ?? 0)) ** 2 + (g - (LV[gi] ?? 0)) ** 2 + (b - (LV[bi] ?? 0)) ** 2;
  const dg = (r - gv) ** 2 + (g - gv) ** 2 + (b - gv) ** 2;
  return dg < dc ? 232 + gl : cube;
}
function fgCode(k: Key, d: ColorMode): string {
  const rgb = PAL[k];
  return d === 'truecolor' ? `38;2;${rgb.join(';')}` : d === '256' ? `38;5;${to256(rgb)}` : String(C16[k]);
}
function bgCode(k: Key, d: ColorMode): string {
  const rgb = PAL[k];
  return d === 'truecolor' ? `48;2;${rgb.join(';')}` : d === '256' ? `48;5;${to256(rgb)}` : String(C16[k] + 10);
}

// ---- Capability detection -------------------------------------------------------------------------------
function pickVariant(c: Pick<Caps, 'width' | 'height' | 'unicode'>): Variant {
  if (c.width < 44 || c.height < 14) return 'mini';
  if (c.width < 80 || c.height < 24 || !c.unicode) return 'compact';
  return 'full';
}
export function detect(o: BannerOptions = {}, stream: TermStream = process.stdout): Caps {
  const env = process.env, tty = Boolean(stream.isTTY);
  const width = o.width || stream.columns || 80, height = o.height || stream.rows || 24;
  const want = o.color;
  let color: ColorMode;
  if (want === true) color = 'truecolor';
  else if (want === false) color = 'none';
  else if (want !== undefined && want !== 'auto') color = want;
  else {
    const f = env['FORCE_COLOR'];
    if (f !== undefined && f !== '') color = FORCE[f] ?? '16';
    else if (env['NO_COLOR'] || env['CAUSYNE_NO_COLOR'] === '1') color = 'none';
    else if (!tty || env['TERM'] === 'dumb') color = 'none';
    else {
      const d = stream.getColorDepth?.() ?? 4;
      color = /truecolor|24bit/i.test(env['COLORTERM'] ?? '') || d >= 24 ? 'truecolor' : d >= 8 ? '256' : d >= 4 ? '16' : 'none';
    }
  }
  let unicode = o.unicode;
  if (unicode === undefined) {
    const loc = env['LC_ALL'] || env['LC_CTYPE'] || env['LANG'] || '', ascii = env['CAUSYNE_ASCII'];
    unicode = !(ascii && ascii !== '0') && !(process.platform !== 'win32' && loc !== '' && !/utf-?8/i.test(loc));
  }
  const caps: Caps = { tty, width, height, color, unicode, variant: 'full' };
  caps.variant = o.variant && o.variant !== 'auto' ? o.variant : pickVariant(caps);
  return caps;
}

// ---- Pixel canvas -> terminal cells ---------------------------------------------------------------------
const blank = (w: number, h: number): Canvas => Array.from({ length: h }, () => Array<Px>(w).fill(null));
function blit(dst: Canvas, src: Canvas, x: number, y: number): void {
  src.forEach((row, j) => row.forEach((k, i) => { const d = dst[y + j]; if (d && k) d[x + i] = k; }));
}
const pixLogo = (g: readonly string[], active: number): Canvas => g.map((r) => [...r].map((ch): Px => (ch === '.' ? null : Number(ch) === active ? 'lime' : 'gray')));
function pixText(str: string, font: Font, h: number, gap: number, key: Key): Canvas {
  const rows: Canvas = Array.from({ length: h }, () => []);
  [...str].forEach((ch, i) => {
    const glyph = font[ch];
    if (!glyph) return;
    rows.forEach((row, y) => {
      if (i) for (let k = 0; k < gap; k++) row.push(null);
      for (const c of glyph[y] ?? '') row.push(c === '#' ? key : null);
    });
  });
  return rows;
}
function cells(px: Canvas, caps: Caps): string[] {
  const { color, unicode } = caps, lines: string[] = [];
  for (let y = 0; y < px.length; y += 2) {
    const top = px[y] ?? [], bot = px[y + 1] ?? [], w = Math.max(top.length, bot.length);
    let s = '', fg: Key | null = null, bg: Key | null = null;
    for (let x = 0; x < w; x++) {
      const t = top[x] ?? null, b = bot[x] ?? null;
      let ch = ' ', f: Key | null = null, g: Key | null = null;
      if (t || b) {
        if (unicode) {
          if (color === 'none') ch = t && b ? ((t && STRONG[t]) || (b && STRONG[b]) ? '█' : '▒') : t ? '▀' : '▄';
          else if (t === b) { ch = '█'; f = t; }
          else if (!b) { ch = '▀'; f = t; }
          else if (!t) { ch = '▄'; f = b; }
          else { ch = '▀'; f = t; g = b; }
        } else {
          const k: Key | null = (t && STRONG[t] ? t : null) || (b && STRONG[b] ? b : null) || t || b, st = k ? STRONG[k] : false;
          ch = t && b ? (st ? '@' : '%') : t ? (st ? "'" : '"') : st ? '.' : ',';
          f = color === 'none' ? null : k;
        }
      }
      if (color !== 'none') {
        if (g !== bg) { s += ESC + (g ? bgCode(g, color) : '49') + 'm'; bg = g; }
        if (f && f !== fg) { s += ESC + fgCode(f, color) + 'm'; fg = f; }
      }
      s += ch;
    }
    if (fg || bg) s += RESET;
    lines.push(s);
  }
  return lines;
}
function txt(str: string, key: Key, caps: Caps, maxw?: number, bold?: boolean): string {
  if (maxw !== undefined && str.length > maxw) str = str.slice(0, Math.max(0, maxw - 1)) + (caps.unicode ? '…' : '~');
  if (caps.color === 'none') return str;
  return ESC + (bold ? '1;' : '') + fgCode(key, caps.color) + 'm' + str + RESET;
}

// ---- Status line ----------------------------------------------------------------------------------------
function shortPath(p: string, maxw: number): string {
  const home = homedir();
  if (home && (p === home || p.startsWith(home + '/') || p.startsWith(home + '\\'))) p = '~' + p.slice(home.length);
  if (p.length <= maxw) return p;
  return (maxw > 4 ? '...' : '') + p.slice(p.length - Math.max(1, maxw - 3));
}
function statusLine(info: BannerInfo, maxw: number, unicode: boolean): string {
  const sep = unicode ? '  ·  ' : '  |  ';
  const providerModel = [info.provider, info.model].filter(Boolean).join('/');
  const providerPart = providerModel || 'select provider';
  const parts = [info.version ? 'v' + String(info.version).replace(/^v/, '') : '', providerPart, info.mode ?? '', info.cwd ?? ''].filter(Boolean);
  const fits = (): boolean => parts.join(sep).length <= maxw;
  if (!fits() && info.cwd) {
    const others = parts.slice(0, -1).join(sep).length + (parts.length > 1 ? sep.length : 0);
    parts[parts.length - 1] = shortPath(info.cwd, Math.max(8, maxw - others));
  }
  while (!fits() && parts.length > 1) parts.pop();
  return parts.join(sep);
}

// ---- Layouts --------------------------------------------------------------------------------------------
function layoutFull(caps: Caps, info: BannerInfo, active: number): string[] {
  const R = LOGO_L.length / 2, logo = cells(pixLogo(LOGO_L, active), caps), gap = '   ';
  const right = blank(48, R * 2);
  blit(right, pixText('CAUSYNE', F7, 7, 1, 'white'), 0, 2); // rows 1-4
  blit(right, pixText('AGENT', F5, 5, 2, 'lime'), 0, 12); // rows 6-8
  // Keep the metadata inside the wordmark's 48-pixel measure. Letting a long
  // workspace consume every spare terminal column made the mark look detached
  // from its own status line and prevented the prompt from widening once a
  // session began.
  const maxw = Math.min(48, caps.width - 2 - (LOGO_L[0]?.length ?? 0) - gap.length);
  return cells(right, caps).map((tail, r) => {
    if (r === R - 2) tail = txt(TAGLINE, 'dim', caps, maxw);
    if (r === R - 1) tail = txt(statusLine(info, maxw, caps.unicode), 'dim', caps, maxw);
    return ' ' + (logo[r] ?? '') + gap + tail;
  });
}
function layoutCompact(caps: Caps, info: BannerInfo, active: number): string[] {
  const logo = cells(pixLogo(LOGO_S, active), caps), gap = '   ';
  const maxw = Math.max(10, caps.width - 2 - (LOGO_S[0]?.length ?? 0) - gap.length), wide = maxw >= 24;
  return logo.map((l, r) => {
    let tail = '';
    if (r === 3) tail = txt(wide ? 'C A U S Y N E' : 'CAUSYNE', 'white', caps, undefined, true) + txt(wide ? '  A G E N T' : ' AGENT', 'lime', caps, undefined, true);
    else if (r === 4) tail = txt(TAGLINE, 'dim', caps, maxw);
    else if (r === 6) tail = txt(statusLine(info, maxw, caps.unicode), 'dim', caps, maxw);
    return ' ' + l + (tail ? gap + tail : '');
  });
}
function layoutMini(caps: Caps, info: BannerInfo): string[] {
  const ver = info.version ? '  v' + String(info.version).replace(/^v/, '') : '';
  let line = txt(caps.unicode ? '■' : '#', 'lime', caps) + ' ' + txt('CAUSYNE', 'white', caps, undefined, true) + txt(' AGENT', 'lime', caps, undefined, true);
  if (ver && 'x CAUSYNE AGENT'.length + ver.length <= caps.width - 2) line += txt(ver, 'dim', caps);
  return [' ' + line];
}

// ---- Public API -----------------------------------------------------------------------------------------
/** Returns the banner as a string (no trailing newline). */
export function renderBanner(o: BannerOptions = {}, stream: TermStream = process.stdout): string {
  const caps = detect(o, stream), active = o.active ?? 0;
  if (caps.variant === 'full' && !caps.unicode) caps.variant = 'compact';
  const lines = caps.variant === 'mini' ? layoutMini(caps, o) : caps.variant === 'compact' ? layoutCompact(caps, o, active) : layoutFull(caps, o, active);
  return lines.join('\n');
}

/**
 * Preserve the TUI's established banner API while rendering the canonical
 * aperture and wordmark above. The returned rows are ordinary terminal history;
 * callers decide when to write them and never need to repaint the screen.
 */
export function wordmark(width = 80, options: Pick<BannerOptions, 'unicode' | 'color' | 'height'> = {}): string[] {
  return renderBanner({ ...options, width, height: options.height ?? 24 }, process.stdout).split('\n');
}

/** A single display spelling for configured providers. */
export function providerLabel(provider: unknown): string {
  const raw = String(provider ?? '').trim();
  if (!raw) return '';
  const known: Record<string, string> = {
    openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini', ollama: 'Ollama',
    deepseek: 'DeepSeek', dashscope: 'DashScope', 'dashscope-byok': 'DashScope',
    qwen: 'Qwen', xai: 'xAI', grok: 'xAI', moonshot: 'Moonshot', kimi: 'Moonshot',
    muse: 'Meta', meta: 'Meta', 'openai-compatible': 'OpenAI-compatible'
  };
  return known[raw.toLowerCase()] ?? raw;
}

function sessionInfo(info: BannerInfo): BannerInfo {
  const provider = providerLabel(info.provider);
  const modeParts = [
    info.autonomyMode ? `mode ${info.autonomyMode}` : info.mode,
    info.tier ? `tier ${info.tier}` : undefined
  ].filter((part): part is string => Boolean(part));
  return {
    ...(info.version ? { version: info.version } : {}),
    ...(provider ? { provider } : {}),
    ...(info.model ? { model: info.model } : {}),
    ...(modeParts.length ? { mode: modeParts.join(' / ') } : {}),
    ...(info.workspace || info.cwd ? { cwd: info.workspace ?? info.cwd } : {})
  };
}

/** Render the adaptive session identity block used by ChatRenderer. */
export function sessionBanner(
  info: BannerInfo = {},
  width = 80,
  options: Pick<BannerOptions, 'unicode' | 'color' | 'height'> = {}
): string[] {
  const height = options.height ?? process.stdout.rows ?? 24;
  // The chat surface also needs room for its input band and hint row. The
  // standalone renderer keeps the source design's 80x24 full-banner threshold,
  // while the integrated session header chooses the same artwork at a size that
  // cannot push the first prompt off short terminals.
  const variant: Variant = height < 22 || width < 44
    ? 'mini'
    : width < 96 || height < 28 || options.unicode === false
      ? 'compact'
      : 'full';
  return renderBanner({
    ...sessionInfo(info),
    ...options,
    variant,
    width,
    height
  }, process.stdout).split('\n');
}

/** Prints the banner. Returns false (prints nothing) when stdout is not a TTY, unless `force` is set. */
export function printBanner(o: BannerOptions = {}, stream: TermStream = process.stdout): boolean {
  if (!stream.isTTY && !o.force) return false;
  stream.write(renderBanner(o, stream) + '\n');
  return true;
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Optional standalone boot animation. The main chat TUI deliberately writes once to preserve scrollback. */
export async function animateBanner(o: BannerOptions = {}, stream: TermStream = process.stdout): Promise<boolean> {
  const caps = detect(o, stream), env = process.env;
  if (!stream.isTTY || caps.color === 'none' || !caps.unicode || caps.variant === 'mini' || o.animate === false || env['CI'] || env['CAUSYNE_NO_ANIM'] || env['TERM'] === 'dumb') return printBanner(o, stream);
  const frames = [0, 1, 2, 3, 4, 5, 0].map((active) => renderBanner({ ...o, active }, stream).split('\n'));
  const first = frames[0] ?? [], count = first.length, show = (): void => { stream.write('\x1b[?25h'); };
  process.once('exit', show);
  try {
    stream.write('\x1b[?25l' + first.join('\n') + '\n');
    for (const frame of frames.slice(1)) {
      await sleep(o.frameMs ?? 70);
      stream.write(`\x1b[${count}A` + frame.map((line) => line + '\x1b[K').join('\n') + '\n');
    }
  } finally {
    show();
    process.removeListener('exit', show);
  }
  return true;
}

export const EXAMPLES = [
  'summarise what changed in this repo today',
  'find every TODO left in src/ and group them by file',
  'explain what this project does and how it is wired',
  'run the tests and tell me what broke',
  'review my last commit for anything risky'
] as const;

/** One example, chosen once per session rather than once per keystroke. */
export function pickExample(): string {
  return EXAMPLES[Math.floor(Math.random() * EXAMPLES.length)] ?? EXAMPLES[0];
}

/** Drop complete hint fragments until the remaining line fits. */
export function fitHints(parts: string[], width: number, fallback: string): string {
  const separator = '  ·  ';
  const kept = parts.slice();
  while (kept.length > 1 && kept.join(separator).length > width) kept.pop();
  const line = kept.join(separator);
  return line.length <= width ? line : fallback;
}
