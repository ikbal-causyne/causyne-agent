export const STUDIO_LAYOUT_KEY = 'causyne/web/studioLayout/v1';
export const VALID_STUDIO_TABS = new Set(['start', 'files', 'canvas', 'terminal', 'browser', 'diff', 'cli']);
const MIN_SPLIT_PANE_WIDTH_PX = 280;
export function isValidStudioTab(tab) {
    return typeof tab === 'string' && VALID_STUDIO_TABS.has(tab);
}
export function clampSplitRatio(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n))
        return 0.5;
    return Math.max(0.25, Math.min(0.75, n));
}
export function pickDistinctSecondaryTab(primaryTab, preferred) {
    if (preferred && isValidStudioTab(preferred) && preferred !== primaryTab)
        return preferred;
    const fallbacks = ['terminal', 'browser', 'files', 'canvas', 'diff', 'cli', 'start'];
    for (const candidate of fallbacks) {
        if (candidate !== primaryTab)
            return candidate;
    }
    return 'terminal';
}
export function halvesFitWidth(containerWidthPx) {
    return Number.isFinite(containerWidthPx) && containerWidthPx >= MIN_SPLIT_PANE_WIDTH_PX * 2;
}
export function normalizeOpenTabs(rawTabs, primaryTab, splitActive, secondaryTab) {
    const out = [];
    const seen = new Set();
    if (Array.isArray(rawTabs)) {
        for (const item of rawTabs) {
            if (isValidStudioTab(item) && !seen.has(item)) {
                seen.add(item);
                out.push(item);
            }
        }
    }
    if (!seen.has(primaryTab)) {
        seen.add(primaryTab);
        out.push(primaryTab);
    }
    if (splitActive && isValidStudioTab(secondaryTab) && !seen.has(secondaryTab)) {
        seen.add(secondaryTab);
        out.push(secondaryTab);
    }
    return out.length > 0 ? out : ['start'];
}
export function loadPersistedStudioLayout() {
    const defaults = {
        openTabs: ['start'],
        primaryTab: 'start',
        splitActive: false,
        secondaryTab: 'terminal',
        splitRatio: 0.5
    };
    try {
        const raw = window.localStorage.getItem(STUDIO_LAYOUT_KEY);
        if (!raw)
            return defaults;
        const parsed = JSON.parse(raw);
        const primaryTab = isValidStudioTab(parsed.primaryTab) ? parsed.primaryTab : defaults.primaryTab;
        const splitActive = Boolean(parsed.splitActive);
        const secondaryTab = pickDistinctSecondaryTab(primaryTab, parsed.secondaryTab);
        const openTabs = normalizeOpenTabs(parsed.openTabs, primaryTab, splitActive, secondaryTab);
        return {
            openTabs,
            primaryTab,
            splitActive,
            secondaryTab,
            splitRatio: clampSplitRatio(parsed.splitRatio)
        };
    }
    catch {
        return defaults;
    }
}
export function persistStudioLayout(layout) {
    try {
        window.localStorage.setItem(STUDIO_LAYOUT_KEY, JSON.stringify({
            openTabs: layout.openTabs,
            primaryTab: layout.primaryTab,
            splitActive: layout.splitActive,
            secondaryTab: layout.secondaryTab,
            splitRatio: clampSplitRatio(layout.splitRatio)
        }));
    }
    catch {
        // Ignore storage unavailability
    }
}
