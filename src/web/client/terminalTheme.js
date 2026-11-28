const ANSI_KEYS = [
    'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'
];
const SPECIAL_KEYS = ['foreground', 'background', 'cursor'];
const DARK_ANSI_PALETTE = {
    black: '#1c201c',
    red: '#f87171',
    green: '#4ade80',
    yellow: '#facc15',
    blue: '#60a5fa',
    magenta: '#c084fc',
    cyan: '#22d3ee',
    white: '#e6ece4',
    brightBlack: '#6b736a',
    brightRed: '#fca5a5',
    brightGreen: '#86efac',
    brightYellow: '#fde047',
    brightBlue: '#93c5fd',
    brightMagenta: '#d8b4fe',
    brightCyan: '#67e8f9',
    brightWhite: '#ffffff'
};
const LIGHT_ANSI_PALETTE = {
    black: '#1f2328',
    red: '#cf222e',
    green: '#116329',
    yellow: '#9a6700',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a40e26',
    brightGreen: '#1a7f37',
    brightYellow: '#bf8700',
    brightBlue: '#218bff',
    brightMagenta: '#a475f9',
    brightCyan: '#3192aa',
    brightWhite: '#8c959f'
};
function colorIndex(value) {
    if (!/^\d{1,3}$/.test(value))
        return undefined;
    const parsed = Number(value);
    return parsed >= 0 && parsed < 256 ? parsed : undefined;
}
function oscColor(value) {
    const rgb = /^rgb:([\da-f]{1,4})\/([\da-f]{1,4})\/([\da-f]{1,4})$/i.exec(value);
    let channels;
    if (rgb !== null) {
        const r = rgb[1];
        const g = rgb[2];
        const b = rgb[3];
        if (!r || !g || !b)
            return undefined;
        channels = [r, g, b];
        if (!channels.every((c) => c.length === r.length))
            return undefined;
    }
    else {
        if (!/^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{9}|[\da-f]{12})$/i.test(value))
            return undefined;
        const width = (value.length - 1) / 3;
        channels = [
            value.slice(1, width + 1),
            value.slice(width + 1, 2 * width + 1),
            value.slice(2 * width + 1)
        ];
    }
    const hex = channels.map((channel) => {
        const n = rgb === null
            ? Number.parseInt(channel.padEnd(2, '0').slice(0, 2), 16)
            : Math.round((Number.parseInt(channel, 16) * 255) / (16 ** channel.length - 1));
        return n.toString(16).padStart(2, '0');
    }).join('');
    return `#${hex}`;
}
/**
 * Tracks application OSC color overrides (OSC 4/10/11/12/104/110-112) separately from
 * Causyne Studio theme defaults so light/dark theme switches preserve program palettes.
 */
export class TerminalTheme {
    terminal;
    defaults = {};
    indexed = new Map();
    special = new Map();
    subscriptions;
    constructor(terminal) {
        this.terminal = terminal;
        const observe = (code, change) => terminal.parser.registerOscHandler(code, (data) => {
            change(data);
            return false;
        });
        this.subscriptions = [
            observe(4, (data) => {
                const parts = data.split(';');
                for (let i = 0; i + 1 < parts.length; i += 2) {
                    const idxRaw = parts[i];
                    const colRaw = parts[i + 1];
                    if (idxRaw === undefined || colRaw === undefined)
                        continue;
                    const index = colorIndex(idxRaw);
                    const color = oscColor(colRaw);
                    if (index !== undefined && color !== undefined)
                        this.indexed.set(index, color);
                }
            }),
            observe(104, (data) => {
                if (data === '') {
                    this.indexed.clear();
                }
                else {
                    for (const part of data.split(';')) {
                        const index = colorIndex(part);
                        if (index !== undefined)
                            this.indexed.delete(index);
                    }
                }
                this.apply();
            }),
            ...SPECIAL_KEYS.flatMap((key, offset) => [
                observe(10 + offset, (data) => {
                    const parts = data.split(';');
                    for (let i = 0; i < parts.length; i += 1) {
                        const target = SPECIAL_KEYS[offset + i];
                        const part = parts[i];
                        if (target === undefined || part === undefined)
                            continue;
                        const color = oscColor(part);
                        if (color !== undefined)
                            this.special.set(target, color);
                    }
                }),
                observe(110 + offset, () => {
                    this.special.delete(key);
                    this.apply();
                })
            ])
        ];
    }
    update(background, foreground, isLight) {
        const basePalette = isLight ? LIGHT_ANSI_PALETTE : DARK_ANSI_PALETTE;
        if (this.defaults.background === background
            && this.defaults.foreground === foreground
            && this.defaults.blue === basePalette.blue) {
            return;
        }
        this.defaults = {
            ...basePalette,
            background,
            foreground,
            cursor: foreground,
            cursorAccent: background,
            selectionBackground: isLight ? 'rgba(9, 105, 218, 0.24)' : 'rgba(147, 197, 253, 0.28)',
            selectionInactiveBackground: isLight ? 'rgba(9, 105, 218, 0.14)' : 'rgba(147, 197, 253, 0.16)'
        };
        this.apply();
    }
    get cursor() {
        return this.special.get('cursor') ?? this.defaults.cursor ?? '#e6ece4';
    }
    dispose() {
        for (const sub of this.subscriptions)
            sub.dispose();
    }
    apply() {
        const theme = { ...this.defaults };
        for (const [k, v] of this.special) {
            theme[k] = v;
        }
        for (const [index, color] of this.indexed) {
            const key = ANSI_KEYS[index];
            if (key !== undefined) {
                theme[key] = color;
            }
            else {
                const ext = theme.extendedAnsi ?? [];
                ext[index - ANSI_KEYS.length] = color;
                theme.extendedAnsi = ext;
            }
        }
        this.terminal.options.theme = theme;
    }
}
function colorChannels(color) {
    if (color.startsWith('#') && color.length >= 7) {
        return [
            Number.parseInt(color.slice(1, 3), 16),
            Number.parseInt(color.slice(3, 5), 16),
            Number.parseInt(color.slice(5, 7), 16)
        ];
    }
    const matches = color.match(/\d+(?:\.\d+)?/g);
    return matches ? matches.map(Number) : [0, 0, 0];
}
function luminance(color) {
    const channels = colorChannels(color);
    const r = (channels[0] ?? 0) / 255;
    const g = (channels[1] ?? 0) / 255;
    const b = (channels[2] ?? 0) / 255;
    const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function opaqueColor(color, background) {
    const channels = colorChannels(color);
    const alpha = channels[3] ?? 1;
    if (alpha >= 1)
        return color;
    const surface = colorChannels(background());
    const rgb = [0, 1, 2].map((i) => Math.round((channels[i] ?? 0) * alpha + (surface[i] ?? 0) * (1 - alpha)));
    return `rgb(${rgb.join(', ')})`;
}
/**
 * Keeps the xterm DOM cursor legible against default, ANSI, true-color, and inverse cells.
 */
export function observeTerminalCursor(terminal, node, preferredCursor) {
    return terminal.onRender(() => {
        const cursor = node.querySelector('.xterm-cursor');
        if (!cursor)
            return;
        cursor.classList.remove('xterm-cursor');
        let background = '#0d100d';
        let foreground = '#e6ece4';
        try {
            const style = window.getComputedStyle(cursor);
            foreground = style.color || foreground;
            const fallbackSurface = () => {
                const scrollEl = node.querySelector('.xterm-scrollable-element');
                return scrollEl
                    ? window.getComputedStyle(scrollEl).backgroundColor
                    : window.getComputedStyle(node).backgroundColor;
            };
            background = opaqueColor(style.backgroundColor, fallbackSurface);
        }
        finally {
            cursor.classList.add('xterm-cursor');
        }
        const preferred = opaqueColor(preferredCursor(), () => background);
        const bgLum = luminance(background);
        const prefLum = luminance(preferred);
        const contrast = (Math.max(bgLum, prefLum) + 0.05) / (Math.min(bgLum, prefLum) + 0.05);
        const fill = contrast >= 3 ? preferred : (bgLum > 0.179 ? '#000000' : '#ffffff');
        node.style.setProperty('--terminal-cursor', fill);
        node.style.setProperty('--terminal-cursor-accent', luminance(fill) > 0.179 ? '#000000' : '#ffffff');
        node.style.setProperty('--terminal-cursor-cell-background', background);
        node.style.setProperty('--terminal-cursor-cell-foreground', foreground);
    });
}
