import { byId, dom } from './dom.js';
import {
  applyStudioWidth,
  restorePersistedPreferences,
  scrollToBottom,
  state,
  updateComposerMetrics
} from './state.js';
import { configureMarkdownCallbacks } from './markdown.js';
import {
  bindStudioResizer,
  bindStudioSplitDivider,
  closeAllPopovers,
  closeStudio,
  configureStudioTabHandlers,
  endStudioResize,
  isStudioResizing,
  isStudioTabVisible,
  openStudio,
  positionPopover,
  restoreStudioLayoutPreference,
  setSecondaryStudioTab,
  swapStudioSplitPanes,
  toggleStudioMaximize,
  toggleStudioNav,
  toggleStudioSplit
} from './studioShell.js';
import {
  bindStudioStartEvents,
  configureStudioStartCallbacks
} from './studioStart.js';
import {
  bindTerminalPanelEvents,
  closeAllTerminalSessions,
  deactivateTerminalPanel,
  fitActiveTerminal,
  focusActiveTerminal,
  loadTerminalSessions,
  openNewTerminalSession
} from './terminalPanel.js';
import {
  bindFilesAndCanvasEvents,
  configureFilesAndCanvasCallbacks,
  loadFiles,
  openFile,
  openInCanvas,
  saveFile
} from './filesAndCanvas.js';
import {
  bindDiffPanelEvents,
  configureDiffPanelCallbacks,
  loadDiff
} from './diffPanel.js';
import {
  bindBrowserPanelEvents,
  closeBrowserWorkspace,
  openBrowserArtifact,
  openBrowserUrl,
  refreshLiveBrowserState,
  startLiveBrowserStream,
  stopLiveBrowserStream,
  syncBrowserViewportToStage
} from './browserPanel.js';
import {
  bindCliPanelEvents,
  configureCliPanelCallbacks,
  loadCliCommands,
  loadCliOverview,
  renderCliQuickGrid,
  runCliCommand
} from './cliPanel.js';
import { bindGameLauncherEvents, loadGameStatus } from './gameLauncherUi.js';
import {
  bindModelPickerEvents,
  configureModelPickerCallbacks,
  loadHealth,
  loadModels
} from './modelPicker.js';
import {
  applyPermissionPresetUi,
  bindPermissionPresetEvents,
  closePermissionConfirmModal,
  loadPermissionPresets
} from './permissionPresetsUi.js';
import {
  bindSettingsModalEvents,
  configureSettingsModalCallbacks,
  loadDoctorReport,
  openSettingsModal
} from './settingsModal.js';
import {
  appendUserTurn,
  configureTurnViewCallbacks,
  createAssistantTurn
} from './turnView.js';
import {
  attachWorkspaceFile,
  bindComposerEvents,
  configureComposerCallbacks
} from './composer.js';
import {
  configureSessionsCallbacks,
  loadSessions,
  renderSessionList,
  saveCurrentSessionWorkspace,
  startFreshChat
} from './sessions.js';
import {
  attachToActiveSessionStream,
  stopActiveRun,
  submitPrompt
} from './chatStream.js';

function wireModuleCallbacks(): void {
  configureMarkdownCallbacks({
    openFile,
    openInCanvas,
    openBrowserArtifact
  });
  configureStudioTabHandlers({
    onFilesTab: () => { void loadFiles(state.currentDir, dom.fileFilterEl.value || ''); },
    onDiffTab: () => { void loadDiff(); },
    onCliTab: () => { void loadCliOverview(); },
    onTerminalActivate: () => {
      void loadTerminalSessions().then(() => {
        fitActiveTerminal();
      });
    },
    onTerminalDeactivate: deactivateTerminalPanel,
    onTerminalClose: () => { void closeAllTerminalSessions(); },
    onBrowserActivate: () => {
      void refreshLiveBrowserState(false).then(() => { syncBrowserViewportToStage(false); });
      startLiveBrowserStream();
    },
    onBrowserDeactivate: stopLiveBrowserStream,
    onBrowserClose: () => { void closeBrowserWorkspace(); },
    onLayoutResized: () => {
      fitActiveTerminal();
      syncBrowserViewportToStage(false);
    }
  });
  configureStudioStartCallbacks({
    openNewTerminal: openNewTerminalSession,
    openSettings: openSettingsModal,
    launchGameStudio: () => { dom.navGameBtn?.click(); }
  });
  configureFilesAndCanvasCallbacks({
    attachWorkspaceFile,
    saveCurrentSessionWorkspace,
    refreshDiffIfOpen: () => { if (state.studioTab === 'diff') void loadDiff(); }
  });
  configureDiffPanelCallbacks({
    openFile,
    saveCurrentSessionWorkspace
  });
  configureCliPanelCallbacks({
    startFreshChat,
    appendUserTurn,
    loadHealth
  });
  configureModelPickerCallbacks({
    createErrorTurn: (message) => {
      const turn = createAssistantTurn('');
      turn.addError(message);
      return turn;
    }
  });
  configureSettingsModalCallbacks({
    loadHealth,
    loadModels
  });
  configureTurnViewCallbacks({
    openFile,
    openInCanvas,
    openBrowserUrl,
    openBrowserArtifact,
    openSettingsForUpgrade: () => openSettingsModal('billing'),
    submitPrompt
  });
  configureComposerCallbacks({
    submitPrompt,
    stopActiveRun,
    runCliCommand
  });
  configureSessionsCallbacks({
    attachToActiveSessionStream
  });
}

function bindShellAndNavigationEvents(): void {
  dom.threadWrapEl.addEventListener('scroll', () => {
    const curTop = dom.threadWrapEl.scrollTop;
    const gap = dom.threadWrapEl.scrollHeight - curTop - dom.threadWrapEl.clientHeight;
    const atBottom = gap <= 24;
    const scrollingDown = curTop >= state.lastScrollTop;
    if (atBottom && scrollingDown) state.stickToBottom = true;
    else if (!atBottom && !scrollingDown) state.stickToBottom = false;
    state.lastScrollTop = curTop;
    dom.scrollBottomBtn.classList.toggle('visible', gap > 72 && !state.stickToBottom);
  }, { passive: true });
  dom.scrollBottomBtn.addEventListener('click', () => scrollToBottom(true, true));

  dom.closeSidebarBtn.addEventListener('click', () => {
    dom.appEl.classList.add('sidebar-collapsed');
    if (dom.appEl.classList.contains('studio-open')) applyStudioWidth(state.studioWidth, false);
  });
  dom.openSidebarBtn.addEventListener('click', () => {
    if (window.innerWidth <= 960 && dom.appEl.classList.contains('studio-open')) closeStudio();
    dom.appEl.classList.remove('sidebar-collapsed');
    if (dom.appEl.classList.contains('studio-open')) applyStudioWidth(state.studioWidth, false);
  });
  dom.sidebarBackdrop.addEventListener('click', () => {
    dom.appEl.classList.add('sidebar-collapsed');
    if (window.innerWidth <= 960 && dom.appEl.classList.contains('studio-open')) closeStudio();
  });

  dom.newChatBtn.addEventListener('click', () => { void startFreshChat(); });
  dom.navFilesBtn.addEventListener('click', () => toggleStudioNav('files'));
  dom.navCanvasBtn.addEventListener('click', () => toggleStudioNav('canvas'));
  dom.navTerminalBtn?.addEventListener('click', () => toggleStudioNav('terminal'));
  dom.navBrowserBtn.addEventListener('click', () => toggleStudioNav('browser'));
  dom.navCliBtn.addEventListener('click', () => toggleStudioNav('cli'));
  dom.navDiffBtn.addEventListener('click', () => toggleStudioNav('diff'));

  dom.studioToggleBtn.addEventListener('click', () => {
    if (dom.appEl.classList.contains('studio-open')) closeStudio();
    else openStudio(state.studioTab || 'start');
  });
  dom.studioNewTabBtn?.addEventListener('click', () => { openStudio('start'); });
  dom.studioSplitBtn?.addEventListener('click', () => { toggleStudioSplit(); });
  dom.studioSecondarySelect?.addEventListener('change', () => {
    if (dom.studioSecondarySelect) setSecondaryStudioTab(dom.studioSecondarySelect.value);
  });
  dom.studioSplitSwapBtn?.addEventListener('click', swapStudioSplitPanes);
  dom.studioSplitCloseBtn?.addEventListener('click', () => toggleStudioSplit(false));
  if (dom.studioExpandBtn) dom.studioExpandBtn.addEventListener('click', toggleStudioMaximize);
  dom.studioCloseBtn.addEventListener('click', closeStudio);

  dom.plusBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = dom.plusPopover.classList.contains('open');
    closeAllPopovers();
    if (!wasOpen) {
      dom.plusBtn.setAttribute('aria-expanded', 'true');
      positionPopover(dom.plusPopover, dom.plusBtn, true);
    }
  });
  byId('plus-attach-file').addEventListener('click', () => { closeAllPopovers(); openStudio('files'); dom.fileFilterEl.focus(); });
  byId('plus-new-idoc').addEventListener('click', () => {
    closeAllPopovers();
    openInCanvas('docs/plan.idoc.md', '# Causyne idoc\n\n## Goal\n\n- \n', false);
  });
  byId('plus-open-browser').addEventListener('click', () => { closeAllPopovers(); openStudio('browser'); dom.browserUrlInput.focus(); });
  byId('plus-open-diff').addEventListener('click', () => { closeAllPopovers(); openStudio('diff'); });
  byId('plus-open-doctor').addEventListener('click', () => {
    closeAllPopovers();
    dom.settingsModal.classList.add('open');
    void loadDoctorReport();
  });

  document.addEventListener('click', (e) => {
    const target = e.target as Node | null;
    if (
      !dom.modelPopover.contains(target) && !dom.modelTriggerBtn.contains(target)
      && !dom.plusPopover.contains(target) && !dom.plusBtn.contains(target)
      && !dom.permPopover.contains(target) && !dom.permTriggerBtn.contains(target)
      && !dom.browserMorePopover.contains(target) && !dom.browserMoreBtn.contains(target)
      && !dom.mentionPopover.contains(target)
    ) {
      closeAllPopovers();
    }
  });

  dom.sessionSearchEl.addEventListener('input', renderSessionList);

  document.addEventListener('keydown', (e) => {
    if (document.activeElement === dom.liveViewportSurface && state.liveBrowserActive) return;
    const inTerminal = Boolean(
      dom.termViewport
      && document.activeElement
      && dom.termViewport.contains(document.activeElement)
      && state.activeTerminalId
    );
    if (inTerminal && !(e.ctrlKey && !e.metaKey && !e.altKey && e.key === '`')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === '`') {
      e.preventDefault();
      openStudio('terminal');
      if (state.terminalSessions.length === 0) void openNewTerminalSession();
      else focusActiveTerminal();
    } else if (mod && e.altKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      openStudio('files');
      dom.fileFilterEl.focus();
    } else if (mod && e.altKey && e.key.toLowerCase() === 't') {
      e.preventDefault();
      openStudio('browser');
      dom.browserUrlInput.focus();
    } else if (mod && e.altKey && e.key === 'Enter') {
      e.preventDefault();
      if (!dom.appEl.classList.contains('studio-open')) openStudio(state.studioTab || 'start');
      toggleStudioMaximize();
    } else if (mod && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      dom.appEl.classList.toggle('sidebar-collapsed');
      if (dom.appEl.classList.contains('studio-open')) applyStudioWidth(state.studioWidth, false);
    } else if (mod && e.key === '\\') {
      e.preventDefault();
      if (dom.appEl.classList.contains('studio-open')) toggleStudioSplit();
      else openStudio(state.studioTab || 'start');
    } else if (mod && e.shiftKey && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      void startFreshChat();
    } else if (mod && e.key.toLowerCase() === 's' && dom.appEl.classList.contains('studio-open') && state.studioTab === 'canvas') {
      e.preventDefault();
      void saveFile();
    } else if (e.key === 'Escape') {
      if (isStudioResizing()) { endStudioResize(true); return; }
      if (dom.permConfirmModal.classList.contains('open')) { closePermissionConfirmModal(); return; }
      if (dom.settingsModal.classList.contains('open')) { dom.settingsModal.classList.remove('open'); return; }
      if (
        dom.modelPopover.classList.contains('open')
        || dom.plusPopover.classList.contains('open')
        || dom.permPopover.classList.contains('open')
        || dom.browserMorePopover.classList.contains('open')
        || dom.mentionPopover.classList.contains('open')
      ) {
        closeAllPopovers();
        return;
      }
      if (dom.appEl.classList.contains('studio-open')) { closeStudio(); return; }
      if (state.activeController) { void stopActiveRun(); }
    }
  });
}

function startBackgroundPollers(): void {
  setInterval(() => {
    if (
      state.activeController
      && dom.appEl.classList.contains('studio-open')
      && isStudioTabVisible('browser')
      && state.browserEngine === 'agent'
      && !state.liveStreamConnected
    ) {
      void refreshLiveBrowserState(false);
      startLiveBrowserStream();
    }
  }, 2000);

  setInterval(() => {
    if (!state.activeController && state.sessions.some((s) => s.running)) {
      void loadSessions();
    }
  }, 4000);
}

function bootstrap(): void {
  restorePersistedPreferences();
  restoreStudioLayoutPreference();
  wireModuleCallbacks();
  bindStudioResizer();
  bindStudioSplitDivider();
  bindStudioStartEvents();
  bindFilesAndCanvasEvents();
  bindDiffPanelEvents();
  bindBrowserPanelEvents();
  bindTerminalPanelEvents();
  bindCliPanelEvents();
  bindGameLauncherEvents();
  bindModelPickerEvents();
  bindPermissionPresetEvents();
  bindSettingsModalEvents();
  bindComposerEvents();
  bindShellAndNavigationEvents();
  startBackgroundPollers();

  applyPermissionPresetUi(state.permissionPreset);
  updateComposerMetrics();
  renderCliQuickGrid();
  dom.promptInput.focus();
  void loadHealth();
  void loadPermissionPresets(state.sessionId);
  void loadGameStatus();
  void loadTerminalSessions();
  void loadSessions();
  void loadFiles('', '');
  void loadCliCommands();
}

bootstrap();
