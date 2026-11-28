import { dom } from './dom.js';
import { DEFAULT_STUDIO_W, applyStudioWidth, state, syncExpandedStudioWidth } from './state.js';
import { clampSplitRatio, halvesFitWidth, isValidStudioTab, loadPersistedStudioLayout, normalizeOpenTabs, persistStudioLayout, pickDistinctSecondaryTab } from './studioLayout.js';
const DEFAULT_TAB_LABELS = {
    start: 'Start',
    files: 'Files',
    canvas: 'Editor',
    terminal: 'Terminal',
    browser: 'Browser',
    diff: 'Changes',
    cli: 'Commands'
};
const dynamicTabTitles = new Map();
let lastActiveStudioTab = null;
let tabHandlers = {
    onFilesTab: () => { },
    onDiffTab: () => { },
    onCliTab: () => { },
    onTerminalActivate: () => { },
    onTerminalDeactivate: () => { },
    onTerminalClose: () => { },
    onBrowserActivate: () => { },
    onBrowserDeactivate: () => { },
    onBrowserClose: () => { },
    onLayoutResized: () => { }
};
export function configureStudioTabHandlers(handlers) {
    tabHandlers = handlers;
}
export function closeAllPopovers() {
    dom.modelPopover.classList.remove('open');
    dom.plusPopover.classList.remove('open');
    dom.permPopover.classList.remove('open');
    dom.permTriggerBtn.classList.remove('open');
    dom.mentionPopover.classList.remove('open');
    dom.browserMorePopover.classList.remove('open');
    dom.modelTriggerBtn.setAttribute('aria-expanded', 'false');
    dom.plusBtn.setAttribute('aria-expanded', 'false');
    dom.permTriggerBtn.setAttribute('aria-expanded', 'false');
    dom.browserMoreBtn.setAttribute('aria-expanded', 'false');
}
export function positionPopover(pop, anchor, preferUp) {
    const rect = anchor.getBoundingClientRect();
    pop.classList.add('open');
    const pw = pop.offsetWidth || 300;
    const ph = pop.offsetHeight || 220;
    let left = rect.left;
    if (left + pw > window.innerWidth - 10)
        left = rect.right - pw;
    left = Math.max(10, Math.min(window.innerWidth - pw - 10, left));
    let top = preferUp ? (rect.top - ph - 8) : (rect.bottom + 8);
    if (top < 10)
        top = rect.bottom + 8;
    if (top + ph > window.innerHeight - 10)
        top = Math.max(10, window.innerHeight - ph - 10);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
}
export function isStudioTabVisible(tab) {
    return state.studioTab === tab || (state.studioSplit && state.studioSecondaryTab === tab);
}
function createSvgElement(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) {
        el.setAttribute(k, v);
    }
    return el;
}
function createTabIconSvg(tab) {
    const svg = createSvgElement('svg', {
        class: 'studio-tab-icon',
        viewBox: '0 0 24 24',
        'aria-hidden': 'true'
    });
    if (tab === 'start') {
        svg.appendChild(createSvgElement('circle', { cx: '12', cy: '12', r: '9' }));
        svg.appendChild(createSvgElement('polygon', { points: '16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76' }));
    }
    else if (tab === 'files') {
        svg.appendChild(createSvgElement('path', { d: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z' }));
    }
    else if (tab === 'canvas') {
        svg.appendChild(createSvgElement('path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }));
        svg.appendChild(createSvgElement('polyline', { points: '14 2 14 8 20 8' }));
    }
    else if (tab === 'terminal') {
        svg.appendChild(createSvgElement('polyline', { points: '4 17 10 11 4 5' }));
        svg.appendChild(createSvgElement('line', { x1: '12', y1: '19', x2: '20', y2: '19' }));
    }
    else if (tab === 'browser') {
        svg.appendChild(createSvgElement('circle', { cx: '12', cy: '12', r: '9' }));
        svg.appendChild(createSvgElement('line', { x1: '3', y1: '12', x2: '21', y2: '12' }));
        svg.appendChild(createSvgElement('path', { d: 'M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18' }));
    }
    else if (tab === 'diff') {
        svg.appendChild(createSvgElement('circle', { cx: '18', cy: '18', r: '3' }));
        svg.appendChild(createSvgElement('circle', { cx: '6', cy: '6', r: '3' }));
        svg.appendChild(createSvgElement('path', { d: 'M6 9v6a3 3 0 0 0 3 3h6' }));
    }
    else {
        svg.appendChild(createSvgElement('polyline', { points: '9 18 15 12 9 6' }));
    }
    return svg;
}
function createCloseIconSvg() {
    const svg = createSvgElement('svg', {
        viewBox: '0 0 24 24',
        'aria-hidden': 'true'
    });
    svg.appendChild(createSvgElement('line', { x1: '18', y1: '6', x2: '6', y2: '18' }));
    svg.appendChild(createSvgElement('line', { x1: '6', y1: '6', x2: '18', y2: '18' }));
    return svg;
}
function tabDisplayTitle(tab) {
    const dynamic = dynamicTabTitles.get(tab);
    if (dynamic && dynamic.trim())
        return dynamic.trim();
    return DEFAULT_TAB_LABELS[tab] || tab;
}
function persistCurrentLayout() {
    persistStudioLayout({
        openTabs: state.studioOpenTabs,
        primaryTab: state.studioTab,
        splitActive: state.studioSplit,
        secondaryTab: state.studioSecondaryTab,
        splitRatio: state.studioSplitRatio
    });
}
function applySplitRatioVar() {
    const ratio = clampSplitRatio(state.studioSplitRatio);
    state.studioSplitRatio = ratio;
    const leftPct = `${(ratio * 100).toFixed(2)}%`;
    const rightPct = `${((1 - ratio) * 100).toFixed(2)}%`;
    if (dom.studioPanesGrid) {
        dom.studioPanesGrid.style.setProperty('--studio-split-left', leftPct);
        dom.studioPanesGrid.style.setProperty('--studio-split-right', rightPct);
    }
}
export function setStudioTabDynamicTitle(tab, title) {
    if (!isValidStudioTab(tab))
        return;
    const clean = typeof title === 'string' ? title.trim().slice(0, 40) : '';
    const prev = dynamicTabTitles.get(tab) || '';
    if (clean === prev)
        return;
    if (clean)
        dynamicTabTitles.set(tab, clean);
    else
        dynamicTabTitles.delete(tab);
    const labelEl = dom.studioTabs?.querySelector(`.studio-tab[data-tab="${tab}"] .studio-tab-label`);
    if (labelEl) {
        const nextText = tabDisplayTitle(tab);
        labelEl.textContent = nextText;
        const chipEl = labelEl.closest('.studio-tab');
        if (chipEl)
            chipEl.title = nextText;
    }
}
function scrollActiveTabIntoView() {
    const strip = dom.studioTabs;
    if (!strip)
        return;
    const activeChip = strip.querySelector('.studio-tab.active');
    if (!activeChip)
        return;
    const stripRect = strip.getBoundingClientRect();
    if (stripRect.width <= 0)
        return;
    const chipRect = activeChip.getBoundingClientRect();
    if (chipRect.left < stripRect.left) {
        strip.scrollLeft = Math.max(0, strip.scrollLeft - (stripRect.left - chipRect.left) - 6);
    }
    else if (chipRect.right > stripRect.right) {
        strip.scrollLeft = strip.scrollLeft + (chipRect.right - stripRect.right) + 6;
    }
}
export function renderStudioTabs() {
    const strip = dom.studioTabs;
    if (!strip)
        return;
    const effectiveSplit = state.studioSplit && state.studioSecondaryTab !== state.studioTab;
    const openTabs = normalizeOpenTabs(state.studioOpenTabs, state.studioTab, effectiveSplit, state.studioSecondaryTab);
    state.studioOpenTabs = openTabs;
    const isQuietLoneStart = openTabs.length === 1 && openTabs[0] === 'start' && !effectiveSplit;
    strip.textContent = '';
    openTabs.forEach((tab, index) => {
        if (index > 0) {
            const slot = document.createElement('span');
            slot.className = 'studio-tab-slot';
            slot.setAttribute('aria-hidden', 'true');
            strip.appendChild(slot);
        }
        const isPrimary = tab === state.studioTab;
        const isSecondary = effectiveSplit && tab === state.studioSecondaryTab;
        const closable = !isQuietLoneStart;
        const labelText = tabDisplayTitle(tab);
        const chip = document.createElement('div');
        chip.className = 'studio-tab';
        if (isPrimary)
            chip.classList.add('active');
        if (isSecondary)
            chip.classList.add('split-secondary');
        if (isQuietLoneStart)
            chip.classList.add('quiet');
        chip.setAttribute('data-tab', tab);
        chip.setAttribute('role', 'tab');
        chip.setAttribute('aria-selected', isPrimary ? 'true' : 'false');
        chip.tabIndex = isPrimary ? 0 : -1;
        chip.title = labelText;
        const titleWrap = document.createElement('span');
        titleWrap.className = 'studio-tab-title';
        titleWrap.appendChild(createTabIconSvg(tab));
        const label = document.createElement('span');
        label.className = 'studio-tab-label';
        label.textContent = labelText;
        titleWrap.appendChild(label);
        chip.appendChild(titleWrap);
        chip.addEventListener('click', (e) => {
            const target = e.target;
            if (target && target.closest('.studio-tab-close'))
                return;
            setStudioTab(tab);
        });
        chip.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setStudioTab(tab);
            }
        });
        if (closable) {
            chip.addEventListener('auxclick', (e) => {
                if (e.button === 1) {
                    e.preventDefault();
                    closeStudioTab(tab);
                }
            });
            const closeBtn = document.createElement('button');
            closeBtn.type = 'button';
            closeBtn.className = 'studio-tab-close';
            closeBtn.setAttribute('aria-label', `Close ${labelText}`);
            closeBtn.title = `Close ${labelText}`;
            closeBtn.appendChild(createCloseIconSvg());
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                closeStudioTab(tab);
            });
            chip.appendChild(closeBtn);
        }
        strip.appendChild(chip);
    });
    scrollActiveTabIntoView();
    window.requestAnimationFrame(scrollActiveTabIntoView);
}
function syncStudioPanes() {
    const effectiveSplit = state.studioSplit && state.studioSecondaryTab !== state.studioTab;
    dom.appEl.classList.toggle('studio-split', effectiveSplit);
    applySplitRatioVar();
    if (dom.studioSplitBar)
        dom.studioSplitBar.classList.toggle('open', effectiveSplit);
    if (dom.studioSplitBtn) {
        dom.studioSplitBtn.classList.toggle('active', effectiveSplit);
        dom.studioSplitBtn.setAttribute('aria-pressed', effectiveSplit ? 'true' : 'false');
    }
    if (dom.studioSecondarySelect && dom.studioSecondarySelect.value !== state.studioSecondaryTab) {
        dom.studioSecondarySelect.value = state.studioSecondaryTab;
    }
    renderStudioTabs();
    document.querySelectorAll('.studio-pane').forEach((p) => {
        const t = p.getAttribute('data-pane') || '';
        const isPrimary = t === state.studioTab;
        const isSecondary = effectiveSplit && t === state.studioSecondaryTab;
        p.classList.toggle('active', isPrimary || isSecondary);
        p.classList.toggle('pane-primary', isPrimary);
        p.classList.toggle('pane-secondary', isSecondary);
    });
}
function notifyVisibleTabs() {
    if (!dom.appEl.classList.contains('studio-open'))
        return;
    if (isStudioTabVisible('files'))
        tabHandlers.onFilesTab();
    if (isStudioTabVisible('diff'))
        tabHandlers.onDiffTab();
    if (isStudioTabVisible('cli'))
        tabHandlers.onCliTab();
    if (isStudioTabVisible('terminal'))
        tabHandlers.onTerminalActivate();
    else
        tabHandlers.onTerminalDeactivate();
    if (isStudioTabVisible('browser') && state.browserEngine === 'agent') {
        tabHandlers.onBrowserActivate();
    }
    else {
        tabHandlers.onBrowserDeactivate();
    }
    tabHandlers.onLayoutResized();
}
export function syncPanelChromeState() {
    const isOpen = dom.appEl.classList.contains('studio-open');
    dom.studioToggleBtn.classList.toggle('active', isOpen);
    dom.studioToggleBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    if (dom.studioExpandBtn) {
        dom.studioExpandBtn.classList.toggle('active', state.studioExpanded);
        dom.studioExpandBtn.title = state.studioExpanded ? 'Restore panel width' : 'Expand panel (⌘⌥↵)';
    }
    const navPairs = [
        [dom.navFilesBtn, 'files'],
        [dom.navCanvasBtn, 'canvas'],
        [dom.navTerminalBtn, 'terminal'],
        [dom.navBrowserBtn, 'browser'],
        [dom.navCliBtn, 'cli'],
        [dom.navDiffBtn, 'diff']
    ];
    for (const [btn, tab] of navPairs) {
        if (!btn)
            continue;
        btn.classList.toggle('active', isOpen && isStudioTabVisible(tab));
    }
}
export function restoreStudioLayoutPreference() {
    const saved = loadPersistedStudioLayout();
    state.studioOpenTabs = saved.openTabs;
    state.studioTab = saved.primaryTab;
    state.studioSplit = saved.splitActive;
    state.studioSecondaryTab = saved.secondaryTab;
    state.studioSplitRatio = saved.splitRatio;
    syncStudioPanes();
}
export function setStudioTab(tab) {
    const nextTab = isValidStudioTab(tab) ? tab : 'start';
    if (state.studioTab && state.studioTab !== nextTab && state.studioTab !== 'start') {
        lastActiveStudioTab = state.studioTab;
    }
    if (!state.studioOpenTabs.includes(nextTab)) {
        // Opening a concrete tool from a lone Start tab replaces Start smoothly,
        // while opening Start via "+" appends it as a launch tab.
        if (nextTab !== 'start'
            && state.studioOpenTabs.length === 1
            && state.studioOpenTabs[0] === 'start'
            && !state.studioSplit) {
            state.studioOpenTabs = [nextTab];
        }
        else {
            state.studioOpenTabs = [...state.studioOpenTabs, nextTab];
        }
    }
    if (state.studioSplit && nextTab === state.studioSecondaryTab) {
        state.studioSecondaryTab = pickDistinctSecondaryTab(nextTab, state.studioTab);
    }
    state.studioTab = nextTab;
    persistCurrentLayout();
    syncStudioPanes();
    syncPanelChromeState();
    notifyVisibleTabs();
}
export function closeStudioTab(tab) {
    if (!isValidStudioTab(tab))
        return;
    const idx = state.studioOpenTabs.indexOf(tab);
    if (idx === -1)
        return;
    if (tab === 'browser') {
        dynamicTabTitles.delete('browser');
        tabHandlers.onBrowserClose();
    }
    else if (tab === 'terminal') {
        dynamicTabTitles.delete('terminal');
        tabHandlers.onTerminalClose();
    }
    else if (tab === 'canvas') {
        dynamicTabTitles.delete('canvas');
    }
    const remaining = state.studioOpenTabs.filter((t) => t !== tab);
    if (remaining.length === 0) {
        state.studioOpenTabs = ['start'];
        state.studioTab = 'start';
        state.studioSplit = false;
    }
    else {
        state.studioOpenTabs = remaining;
        if (state.studioSplit) {
            if (remaining.length < 2) {
                state.studioSplit = false;
                state.studioTab = remaining[0] || 'start';
            }
            else if (tab === state.studioTab) {
                const nextPrimary = remaining.find((t) => t !== state.studioSecondaryTab) || remaining[0] || 'start';
                state.studioTab = nextPrimary;
            }
            else if (tab === state.studioSecondaryTab) {
                const nextSecondary = remaining.find((t) => t !== state.studioTab) || pickDistinctSecondaryTab(state.studioTab);
                state.studioSecondaryTab = nextSecondary;
            }
        }
        else if (tab === state.studioTab) {
            const nextIdx = Math.min(idx, remaining.length - 1);
            state.studioTab = remaining[nextIdx] || 'start';
        }
    }
    persistCurrentLayout();
    syncStudioPanes();
    syncPanelChromeState();
    notifyVisibleTabs();
}
export function setSecondaryStudioTab(tab) {
    if (!isValidStudioTab(tab))
        return;
    if (!state.studioOpenTabs.includes(tab)) {
        state.studioOpenTabs = [...state.studioOpenTabs, tab];
    }
    if (tab === state.studioTab) {
        const prevPrimary = state.studioTab;
        state.studioTab = state.studioSecondaryTab;
        state.studioSecondaryTab = prevPrimary;
    }
    else {
        state.studioSecondaryTab = tab;
    }
    persistCurrentLayout();
    syncStudioPanes();
    syncPanelChromeState();
    notifyVisibleTabs();
}
export function toggleStudioSplit(force) {
    const nextSplit = typeof force === 'boolean' ? force : !state.studioSplit;
    if (nextSplit) {
        if (!dom.appEl.classList.contains('studio-open')) {
            openStudio(state.studioTab || 'start');
        }
        const studioRectW = dom.studioRoot?.getBoundingClientRect().width || state.studioWidth;
        if (!halvesFitWidth(studioRectW) && !state.studioExpanded) {
            state.studioExpanded = true;
            if (window.innerWidth > 960 && window.innerWidth < 1380) {
                dom.appEl.classList.add('sidebar-collapsed');
            }
            syncExpandedStudioWidth();
            dom.appEl.classList.toggle('studio-expanded', true);
        }
        const recentCandidate = lastActiveStudioTab
            && lastActiveStudioTab !== state.studioTab
            && state.studioOpenTabs.includes(lastActiveStudioTab)
            ? lastActiveStudioTab
            : undefined;
        const otherOpen = recentCandidate
            || state.studioOpenTabs.find((t) => t !== state.studioTab && t !== 'start')
            || state.studioOpenTabs.find((t) => t !== state.studioTab);
        state.studioSecondaryTab = pickDistinctSecondaryTab(state.studioTab, otherOpen || state.studioSecondaryTab);
        if (!state.studioOpenTabs.includes(state.studioSecondaryTab)) {
            state.studioOpenTabs = [...state.studioOpenTabs, state.studioSecondaryTab];
        }
    }
    state.studioSplit = nextSplit;
    persistCurrentLayout();
    syncStudioPanes();
    syncPanelChromeState();
    notifyVisibleTabs();
}
export function swapStudioSplitPanes() {
    if (!state.studioSplit)
        return;
    const prevPrimary = state.studioTab;
    state.studioTab = state.studioSecondaryTab;
    state.studioSecondaryTab = prevPrimary;
    persistCurrentLayout();
    syncStudioPanes();
    syncPanelChromeState();
    notifyVisibleTabs();
}
export function openStudio(tab) {
    closeAllPopovers();
    if (window.innerWidth <= 960)
        dom.appEl.classList.add('sidebar-collapsed');
    if (dom.studioRoot) {
        dom.studioRoot.style.flexBasis = '';
        dom.studioRoot.style.width = '';
    }
    applyStudioWidth(state.studioWidth || DEFAULT_STUDIO_W, false);
    dom.appEl.classList.add('studio-open');
    dom.appEl.classList.toggle('studio-expanded', Boolean(state.studioExpanded));
    if (tab) {
        setStudioTab(tab);
    }
    else {
        syncStudioPanes();
        syncPanelChromeState();
        notifyVisibleTabs();
    }
    setTimeout(scrollActiveTabIntoView, 220);
}
export function closeStudio() {
    state.studioExpanded = false;
    dom.appEl.classList.remove('studio-open', 'studio-expanded', 'studio-resizing');
    dom.studioResizer.classList.remove('dragging', 'snap-close');
    if (dom.studioRoot) {
        dom.studioRoot.style.flexBasis = '';
        dom.studioRoot.style.width = '';
    }
    tabHandlers.onBrowserDeactivate();
    tabHandlers.onTerminalDeactivate();
    syncPanelChromeState();
}
export function toggleStudioNav(tab) {
    if (dom.appEl.classList.contains('studio-open') && state.studioTab === tab && !state.studioSplit) {
        closeStudio();
    }
    else {
        openStudio(tab);
    }
}
export function toggleStudioMaximize() {
    if (!dom.appEl.classList.contains('studio-open'))
        return;
    state.studioExpanded = !state.studioExpanded;
    if (state.studioExpanded && window.innerWidth > 960 && window.innerWidth < 1380) {
        dom.appEl.classList.add('sidebar-collapsed');
    }
    syncExpandedStudioWidth();
    dom.appEl.classList.toggle('studio-expanded', state.studioExpanded);
    syncPanelChromeState();
    tabHandlers.onLayoutResized();
}
let resizing = false;
let snapClosePending = false;
let resizePointerId = null;
let resizeStartWidth = DEFAULT_STUDIO_W;
export function isStudioResizing() {
    return resizing;
}
export function endStudioResize(cancelled) {
    if (!resizing)
        return;
    resizing = false;
    const shouldSnapClose = !cancelled && snapClosePending;
    snapClosePending = false;
    dom.appEl.classList.remove('studio-resizing');
    dom.studioResizer.classList.remove('dragging', 'snap-close');
    if (resizePointerId !== null) {
        try {
            dom.studioResizer.releasePointerCapture(resizePointerId);
        }
        catch { /* ignore */ }
        resizePointerId = null;
    }
    if (shouldSnapClose) {
        applyStudioWidth(resizeStartWidth, false);
        closeStudio();
    }
    else if (cancelled) {
        applyStudioWidth(resizeStartWidth, false);
        tabHandlers.onLayoutResized();
    }
    else {
        applyStudioWidth(state.studioWidth, true);
        tabHandlers.onLayoutResized();
    }
}
export function bindStudioResizer() {
    dom.studioResizer.addEventListener('pointerdown', (e) => {
        if (!dom.appEl.classList.contains('studio-open') || state.studioExpanded)
            return;
        e.preventDefault();
        resizing = true;
        snapClosePending = false;
        resizeStartWidth = state.studioWidth || DEFAULT_STUDIO_W;
        resizePointerId = e.pointerId;
        dom.appEl.classList.add('studio-resizing');
        dom.studioResizer.classList.add('dragging');
        try {
            dom.studioResizer.setPointerCapture(e.pointerId);
        }
        catch { /* ignore */ }
    });
    dom.studioResizer.addEventListener('pointermove', (e) => {
        if (!resizing)
            return;
        const rawW = window.innerWidth - e.clientX;
        if (rawW < 210) {
            snapClosePending = true;
            dom.studioResizer.classList.add('snap-close');
            return;
        }
        snapClosePending = false;
        dom.studioResizer.classList.remove('snap-close');
        applyStudioWidth(rawW, false);
    });
    dom.studioResizer.addEventListener('pointerup', () => endStudioResize(false));
    dom.studioResizer.addEventListener('pointercancel', () => endStudioResize(true));
    dom.studioResizer.addEventListener('dblclick', () => {
        if (!dom.appEl.classList.contains('studio-open'))
            return;
        state.studioExpanded = false;
        dom.appEl.classList.remove('studio-expanded');
        applyStudioWidth(DEFAULT_STUDIO_W, true);
        syncPanelChromeState();
        tabHandlers.onLayoutResized();
    });
    window.addEventListener('resize', () => {
        closeAllPopovers();
        if (dom.appEl.classList.contains('studio-open') && window.innerWidth > 960) {
            applyStudioWidth(state.studioWidth, false);
            tabHandlers.onLayoutResized();
        }
    });
}
export function bindStudioSplitDivider() {
    const divider = dom.studioSplitDivider;
    const grid = dom.studioPanesGrid;
    if (!divider || !grid)
        return;
    let splitDragging = false;
    let splitPointerId = null;
    const stopSplitDrag = (persist) => {
        if (!splitDragging)
            return;
        splitDragging = false;
        dom.appEl.classList.remove('studio-resizing');
        divider.classList.remove('dragging');
        if (splitPointerId !== null) {
            try {
                divider.releasePointerCapture(splitPointerId);
            }
            catch { /* ignore */ }
            splitPointerId = null;
        }
        if (persist)
            persistCurrentLayout();
        tabHandlers.onLayoutResized();
    };
    divider.addEventListener('pointerdown', (e) => {
        if (!state.studioSplit)
            return;
        e.preventDefault();
        splitDragging = true;
        splitPointerId = e.pointerId;
        dom.appEl.classList.add('studio-resizing');
        divider.classList.add('dragging');
        try {
            divider.setPointerCapture(e.pointerId);
        }
        catch { /* ignore */ }
    });
    divider.addEventListener('pointermove', (e) => {
        if (!splitDragging)
            return;
        const rect = grid.getBoundingClientRect();
        if (rect.width <= 0)
            return;
        const rawRatio = (e.clientX - rect.left) / rect.width;
        state.studioSplitRatio = clampSplitRatio(rawRatio);
        applySplitRatioVar();
    });
    divider.addEventListener('pointerup', () => stopSplitDrag(true));
    divider.addEventListener('pointercancel', () => stopSplitDrag(false));
    divider.addEventListener('dblclick', () => {
        state.studioSplitRatio = 0.5;
        applySplitRatioVar();
        persistCurrentLayout();
        tabHandlers.onLayoutResized();
    });
}
