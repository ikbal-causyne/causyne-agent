// Anti-AI-Slop Detector (Vision §7, ENFORCED)
/** Files worth scanning. Anything else is not a rendered surface. */
const SCANNABLE_EXTENSIONS = /\.(html?|css|jsx?|tsx?|vue|svelte|astro)$/i;
export function isScannableFile(filePath) {
    return SCANNABLE_EXTENSIONS.test(String(filePath || ''));
}
function hexToHue(hex) {
    const clean = hex.replace('#', '');
    const full = clean.length === 3
        ? clean.split('').map(c => c + c).join('')
        : clean;
    if (!/^[0-9a-f]{6}$/i.test(full))
        return null;
    const r = parseInt(full.slice(0, 2), 16) / 255;
    const g = parseInt(full.slice(2, 4), 16) / 255;
    const b = parseInt(full.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    if (delta === 0)
        return null;
    let hue;
    if (max === r)
        hue = ((g - b) / delta) % 6;
    else if (max === g)
        hue = (b - r) / delta + 2;
    else
        hue = (r - g) / delta + 4;
    hue = Math.round(hue * 60);
    return hue < 0 ? hue + 360 : hue;
}
function isPurpleBlueHue(hue) {
    return hue !== null && hue >= 220 && hue <= 290;
}
const NOTORIOUS_GRADIENT_COLORS = [
    '#667eea', '#764ba2',
    '#6366f1', '#8b5cf6',
    '#a855f7', '#7c3aed',
    '#4f46e5', '#9333ea'
];
function detectNotoriousGradient(text) {
    const lower = text.toLowerCase();
    const hits = NOTORIOUS_GRADIENT_COLORS.filter(color => lower.includes(color));
    if (hits.length < 2)
        return null;
    return {
        id: 'notorious-gradient-hexes',
        weight: 40,
        evidence: `the stock AI gradient colours ${hits.slice(0, 4).join(', ')} appear verbatim`,
        fix: 'Replace with a palette chosen for THIS project. These specific hexes are the most reproduced values in AI-generated design.'
    };
}
function detectPurpleBlueGradient(text) {
    const gradients = text.match(/linear-gradient\s*\([^)]{0,512}\)/gi) || [];
    for (const gradient of gradients) {
        const hexes = gradient.match(/#[0-9a-f]{3,8}\b/gi) || [];
        if (hexes.length < 2)
            continue;
        const hues = hexes.map(hexToHue).filter((hue) => hue !== null);
        if (hues.length >= 2 && hues.every(isPurpleBlueHue)) {
            return {
                id: 'purple-blue-gradient',
                weight: 30,
                evidence: `a gradient runs entirely through the indigo/violet band: ${gradient.slice(0, 80)}`,
                fix: 'Vision §7 bans purple-to-blue as the primary scheme. Commit to a design movement and take the palette from there.'
            };
        }
    }
    return null;
}
const GENERIC_COPY_PATTERNS = [
    /\belevate your\b/i,
    /\btransform your\b/i,
    /\btake your \w+ to the next level\b/i,
    /\bunlock the (full )?power of\b/i,
    /\bsupercharge your\b/i,
    /\brevolutioni[sz]e (your|the)\b/i,
    /\bseamlessly integrate\b/i,
    /\blorem ipsum\b/i,
    /\byour (one[- ]stop|all[- ]in[- ]one) (shop|solution|platform)\b/i,
    /\bempower(ing)? (your|teams?) \w+\b/i
];
function detectGenericCopy(text) {
    const hits = [];
    for (const pattern of GENERIC_COPY_PATTERNS) {
        const match = text.match(pattern);
        if (match && match[0])
            hits.push(match[0]);
    }
    if (hits.length === 0)
        return null;
    return {
        id: 'generic-marketing-copy',
        weight: hits.length >= 2 ? 25 : 15,
        evidence: `filler copy: ${[...new Set(hits)].slice(0, 3).map(h => `"${h}"`).join(', ')}`,
        fix: 'Write copy about what this specific product actually does. Placeholder marketing language is a slop signature in itself.'
    };
}
function detectEmojiIcons(text) {
    const iconEmoji = text.match(/[\u{1F680}\u{2728}\u{1F4A1}\u{1F3AF}\u{26A1}\u{1F512}\u{1F4C8}\u{1F527}\u{1F31F}\u{1F4AA}]/gu) || [];
    if (iconEmoji.length < 3)
        return null;
    return {
        id: 'emoji-as-icons',
        weight: 20,
        evidence: `${iconEmoji.length} placeholder-icon emoji (${[...new Set(iconEmoji)].slice(0, 5).join(' ')})`,
        fix: 'Use a real icon set, or inline SVG drawn for this project. Rocket/sparkle/bulb emoji as feature icons is a template tell.'
    };
}
function detectStockShadow(text) {
    const shadows = text.match(/box-shadow\s*:\s*0\s+(?:10|20)px\s+(?:20|25|30|40)px\s+rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0?\.\d+\s*\)/gi) || [];
    if (shadows.length === 0)
        return null;
    return {
        id: 'stock-soft-shadow',
        weight: 10,
        evidence: `the default soft card shadow appears ${shadows.length}×`,
        fix: 'Shadow should follow the movement you chose — brutalism has none, editorial uses hairline rules, deco uses hard offsets.'
    };
}
function detectDefaultTypography(text) {
    const declaresFontFamily = /font-family\s*:/i.test(text);
    if (!declaresFontFamily)
        return null;
    const loadsWebFont = /@font-face|fonts\.googleapis\.com|fonts\.bunny\.net|@import\s+url\([^)]{0,512}font/i.test(text);
    if (loadsWebFont)
        return null;
    const onlySystemStacks = !/font-family\s*:\s*[^;]{0,512}['"][A-Za-z]/i.test(text);
    if (!onlySystemStacks)
        return null;
    return {
        id: 'default-typography',
        weight: 15,
        evidence: 'every font-family resolves to a system default; no typeface was chosen',
        fix: 'Pick a typeface that belongs to the design movement. Typography is the fastest way out of the house style.'
    };
}
function detectCookieCutterStructure(text) {
    if (!/<html|<body|<section|<main/i.test(text))
        return null;
    const hasCenteredHero = /class\s*=\s*["'][^"']{0,512}\bhero\b/i.test(text) &&
        /text-align\s*:\s*center|\btext-center\b/i.test(text);
    const featureCards = (text.match(/class\s*=\s*["'][^"']{0,512}\b(feature|card)\b/gi) || []).length;
    const hasCtaPair = /get started/i.test(text) && /learn more/i.test(text);
    const signals = [hasCenteredHero, featureCards >= 3, hasCtaPair].filter(Boolean).length;
    if (signals < 2)
        return null;
    return {
        id: 'cookie-cutter-layout',
        weight: signals === 3 ? 25 : 15,
        evidence: `the stock landing skeleton: ${hasCenteredHero ? 'centered hero, ' : ''}${featureCards >= 3 ? `${featureCards} feature cards, ` : ''}${hasCtaPair ? '"Get Started"/"Learn More" pair' : ''}`.replace(/,\s*$/, ''),
        fix: 'Vision §7 bans the centered-hero + gradient + "Get Started" template. Restructure around the content this page actually has.'
    };
}
function detectGradientText(text) {
    if (!/background-clip\s*:\s*text|-webkit-background-clip\s*:\s*text/i.test(text))
        return null;
    const hasPurpleGradient = detectPurpleBlueGradient(text) || detectNotoriousGradient(text);
    if (!hasPurpleGradient)
        return null;
    return {
        id: 'gradient-clipped-headline',
        weight: 15,
        evidence: 'a headline is filled with the same purple gradient',
        fix: 'Gradient-filled display type over a purple ramp is the compound form of the signature. Use solid ink and let layout carry the emphasis.'
    };
}
const SIGNALS = [
    detectNotoriousGradient,
    detectPurpleBlueGradient,
    detectGenericCopy,
    detectEmojiIcons,
    detectStockShadow,
    detectDefaultTypography,
    detectCookieCutterStructure,
    detectGradientText
];
const MAX_SLOP_SCAN_CHARS = 512 * 1024;
export const BORDERLINE_SCORE = 30;
export const SLOP_SCORE = 45;
export function verdictFor(score) {
    if (score >= SLOP_SCORE)
        return 'slop';
    if (score >= BORDERLINE_SCORE)
        return 'borderline';
    return 'clean';
}
export function analyzeSource(text) {
    const rawSource = typeof text === 'string' ? text : '';
    const source = rawSource.length > MAX_SLOP_SCAN_CHARS ? rawSource.slice(0, MAX_SLOP_SCAN_CHARS) : rawSource;
    const findings = [];
    for (const signal of SIGNALS) {
        try {
            const finding = signal(source);
            if (finding)
                findings.push(finding);
        }
        catch {
            // one bad signal must not sink the analysis
        }
    }
    const score = findings.reduce((sum, finding) => sum + finding.weight, 0);
    return { score, verdict: verdictFor(score), findings };
}
export function analyzeFiles(files) {
    const merged = new Map();
    const scanned = [];
    for (const file of Array.isArray(files) ? files : []) {
        if (!file || !isScannableFile(file.path))
            continue;
        scanned.push(file.path);
        for (const finding of analyzeSource(file.content).findings) {
            const existing = merged.get(finding.id);
            if (!existing || finding.weight > existing.weight) {
                merged.set(finding.id, { ...finding, path: file.path });
            }
        }
    }
    const findings = [...merged.values()];
    const score = findings.reduce((sum, finding) => sum + finding.weight, 0);
    return { score, verdict: verdictFor(score), findings, scanned };
}
export function formatFindings(result, movementBrief = '') {
    const safeResult = result && typeof result === 'object' ? result : { score: 0, verdict: 'clean', findings: [] };
    const safeFindings = Array.isArray(safeResult.findings) ? safeResult.findings : [];
    const lines = [];
    lines.push(`[ANTI-SLOP GATE: the generated design scores ${safeResult.score} (${safeResult.verdict}) against Vision §7.]`);
    lines.push('');
    lines.push('Detected signatures:');
    for (const finding of safeFindings) {
        if (!finding || typeof finding !== 'object')
            continue;
        lines.push(`- ${finding.id}${finding.path ? ` (${finding.path})` : ''}: ${finding.evidence}`);
        lines.push(`  → ${finding.fix}`);
    }
    if (movementBrief) {
        lines.push('');
        lines.push('Commit to ONE of these movements and rebuild the visual layer from it:');
        lines.push(movementBrief);
    }
    lines.push('');
    lines.push('Rework the design and verify again. Do not simply swap one gradient for another.');
    return lines.join('\n');
}
