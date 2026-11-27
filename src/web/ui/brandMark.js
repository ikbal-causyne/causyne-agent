const CAUSYNE_BLADE_PATHS = [
    {
        cls: 'b1',
        fill: '#ABDB5F',
        d: 'M 682.32,144.33 A 29.64,29.64 0 0 1 723.52,132.42 L 1071.15,334.84 A 31.71,31.71 0 0 1 1058.12,393.82 L 542.17,441.63 A 8.50,8.50 0 0 1 533.85,429.23 Z'
    },
    {
        cls: 'b2',
        fill: '#383D45',
        d: 'M 1104.54,837.92 A 39.43,39.43 0 0 1 1033.41,861.10 L 741.14,466.14 A 14.97,14.97 0 0 1 751.86,442.32 L 1066.59,414.57 A 37.43,37.43 0 0 1 1107.30,452.12 Z'
    },
    {
        cls: 'b3',
        fill: '#383D45',
        d: 'M 828.50,645.61 A 8.50,8.50 0 0 1 842.76,644.60 L 1029.91,895.29 A 32.64,32.64 0 0 1 1019.14,943.60 L 647.88,1141.98 A 43.37,43.37 0 0 1 589.39,1082.93 Z'
    },
    {
        cls: 'b4',
        fill: '#383D45',
        d: 'M 553.56,1101.63 A 30.36,30.36 0 0 1 510.70,1112.54 L 183.70,904.44 A 38.88,38.88 0 0 1 201.08,832.92 L 696.78,788.28 A 16.97,16.97 0 0 1 713.14,813.39 Z'
    },
    {
        cls: 'b5',
        fill: '#383D45',
        d: 'M 510.57,758.90 A 13.28,13.28 0 0 1 501.43,780.14 L 179.80,814.91 A 30.67,30.67 0 0 1 145.84,784.23 L 148.24,400.27 A 39.69,39.69 0 0 1 219.51,376.48 Z'
    },
    {
        cls: 'b6',
        fill: '#383D45',
        d: 'M 426.44,590.45 A 8.50,8.50 0 0 1 412.13,591.67 L 218.19,336.46 A 28.65,28.65 0 0 1 227.41,293.90 L 598.25,93.95 A 41.84,41.84 0 0 1 655.24,150.07 Z'
    }
];
export function escapeHtmlAttr(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
export function getCausyneFaviconSvg() {
    const outlines = CAUSYNE_BLADE_PATHS.map((b) => `    <path d="${b.d}"/>`).join('\n');
    const fills = CAUSYNE_BLADE_PATHS.map((b) => `    <path fill="${b.fill}" d="${b.d}"/>`).join('\n');
    return [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1254 1254" width="1254" height="1254">',
        '  <title>Causyne</title>',
        '  <g fill="none" stroke="#FFFFFF" stroke-width="16" stroke-linejoin="round" stroke-linecap="round">',
        outlines,
        '  </g>',
        '  <g>',
        fills,
        '  </g>',
        '</svg>'
    ].join('\n');
}
export function renderCausyneMarkSvg(idAttr, extraClass) {
    const idPart = idAttr ? ` id="${idAttr}"` : '';
    const cls = extraClass ? `brand-mark causyne-aperture ${extraClass}` : 'brand-mark causyne-aperture';
    const outlines = CAUSYNE_BLADE_PATHS.map((b) => `<path d="${b.d}"/>`).join('');
    const fills = CAUSYNE_BLADE_PATHS.map((b) => `<path class="causyne-blade ${b.cls}" fill="${b.fill}" d="${b.d}"/>`).join('');
    return [
        `<svg${idPart} class="${cls}" viewBox="0 0 1254 1254" aria-hidden="true">`,
        '<g class="causyne-rotor">',
        '<g class="causyne-outline" fill="none" stroke="#FFFFFF" stroke-width="18" stroke-linejoin="round" stroke-linecap="round">',
        outlines,
        '</g>',
        '<g class="causyne-blades">',
        fills,
        '</g>',
        '</g>',
        '</svg>'
    ].join('\n');
}
