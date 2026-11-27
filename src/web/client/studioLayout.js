export const STUDIO_LAYOUT_KEY = 'causyne/web/studioLayout/v1';
export const VALID_STUDIO_TABS = new Set(['start', 'files', 'canvas', 'terminal', 'browser', 'diff', 'cli']);
const MIN_SPLIT_PANE_WIDTH_PX = 280;
export function isValidStudioTab(tab) {
    return typeof tab === 'string' && VALID_STUDIO_TABS.has(tab);
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
export function loadPersistedStudioLayout() {
    const defaults = {
        primaryTab: 'start',
        splitActive: false,
        secondaryTab: 'terminal'
    };
    try {
        const raw = window.localStorage.getItem(STUDIO_LAYOUT_KEY);
        if (!raw)
            return defaults;
        const parsed = JSON.parse(raw);
        const primaryTab = isValidStudioTab(parsed.primaryTab) ? parsed.primaryTab : defaults.primaryTab;
        const secondaryTab = pickDistinctSecondaryTab(primaryTab, parsed.secondaryTab);
        return {
            primaryTab,
            splitActive: Boolean(parsed.splitActive),
            secondaryTab
        };
    }
    catch {
        return defaults;
    }
}
export function persistStudioLayout(layout) {
    try {
        window.localStorage.setItem(STUDIO_LAYOUT_KEY, JSON.stringify({
            primaryTab: layout.primaryTab,
            splitActive: layout.splitActive,
            secondaryTab: layout.secondaryTab
        }));
    }
    catch {
        // Ignore storage unavailability
    }
}
