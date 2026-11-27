import { dom } from './dom.js';
import { DEFAULT_STUDIO_W, applyStudioWidth, state, syncExpandedStudioWidth } from './state.js';
import { halvesFitWidth, isValidStudioTab, loadPersistedStudioLayout, persistStudioLayout, pickDistinctSecondaryTab } from './studioLayout.js';
let tabHandlers = {
    onFilesTab: () => { },
    onDiffTab: () => { },
    onCliTab: () => { },
    onTerminalActivate: () => { },
    onTerminalDeactivate: () => { },
    onBrowserActivate: () => { },
    onBrowserDeactivate: () => { }
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
function isTabVisible(tab) {
    return state.studioTab === tab || (state.studioSplit && state.studioSecondaryTab === tab);
}
function syncStudioPanes() {
    const effectiveSplit = state.studioSplit && state.studioSecondaryTab !== state.studioTab;
    dom.appEl.classList.toggle('studio-split', effectiveSplit);
    if (dom.studioSplitBar)
        dom.studioSplitBar.classList.toggle('open', effectiveSplit);
    if (dom.studioSplitBtn) {
        dom.studioSplitBtn.classList.toggle('active', effectiveSplit);
        dom.studioSplitBtn.setAttribute('aria-pressed', effectiveSplit ? 'true' : 'false');
    }
    if (dom.studioSecondarySelect && dom.studioSecondarySelect.value !== state.studioSecondaryTab) {
        dom.studioSecondarySelect.value = state.studioSecondaryTab;
    }
    document.querySelectorAll('.studio-tab').forEach((b) => {
        const t = b.getAttribute('data-tab') || '';
        b.classList.toggle('active', t === state.studioTab);
        b.classList.toggle('split-secondary', effectiveSplit && t === state.studioSecondaryTab);
    });
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
    if (isTabVisible('files'))
        tabHandlers.onFilesTab();
    if (isTabVisible('diff'))
        tabHandlers.onDiffTab();
    if (isTabVisible('cli'))
        tabHandlers.onCliTab();
    if (isTabVisible('terminal'))
        tabHandlers.onTerminalActivate();
    else
        tabHandlers.onTerminalDeactivate();
    if (isTabVisible('browser') && state.browserEngine === 'agent') {
        tabHandlers.onBrowserActivate();
    }
    else {
        tabHandlers.onBrowserDeactivate();
    }
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
        btn.classList.toggle('active', isOpen && isTabVisible(tab));
    }
}
export function restoreStudioLayoutPreference() {
    const saved = loadPersistedStudioLayout();
    state.studioTab = saved.primaryTab;
    state.studioSplit = saved.splitActive;
    state.studioSecondaryTab = saved.secondaryTab;
    syncStudioPanes();
}
export function setStudioTab(tab) {
    const nextTab = isValidStudioTab(tab) ? tab : 'start';
    if (state.studioSplit && nextTab === state.studioSecondaryTab) {
        state.studioSecondaryTab = pickDistinctSecondaryTab(nextTab, state.studioTab);
    }
    state.studioTab = nextTab;
    persistStudioLayout({
        primaryTab: state.studioTab,
        splitActive: state.studioSplit,
        secondaryTab: state.studioSecondaryTab
    });
    syncStudioPanes();
    syncPanelChromeState();
    notifyVisibleTabs();
}
export function setSecondaryStudioTab(tab) {
    if (!isValidStudioTab(tab))
        return;
    if (tab === state.studioTab) {
        const prevPrimary = state.studioTab;
        state.studioTab = state.studioSecondaryTab;
        state.studioSecondaryTab = prevPrimary;
    }
    else {
        state.studioSecondaryTab = tab;
    }
    persistStudioLayout({
        primaryTab: state.studioTab,
        splitActive: state.studioSplit,
        secondaryTab: state.studioSecondaryTab
    });
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
        state.studioSecondaryTab = pickDistinctSecondaryTab(state.studioTab, state.studioSecondaryTab);
    }
    state.studioSplit = nextSplit;
    persistStudioLayout({
        primaryTab: state.studioTab,
        splitActive: state.studioSplit,
        secondaryTab: state.studioSecondaryTab
    });
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
    persistStudioLayout({
        primaryTab: state.studioTab,
        splitActive: state.studioSplit,
        secondaryTab: state.studioSecondaryTab
    });
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
    if (dom.appEl.classList.contains('studio-open') && state.studioTab === tab && !state.studioSplit)
        closeStudio();
    else
        openStudio(tab);
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
    }
    else {
        applyStudioWidth(state.studioWidth, true);
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
    });
    window.addEventListener('resize', () => {
        closeAllPopovers();
        if (dom.appEl.classList.contains('studio-open') && window.innerWidth > 960) {
            applyStudioWidth(state.studioWidth, false);
        }
    });
}
