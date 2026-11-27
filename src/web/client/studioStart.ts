import { dom } from './dom.js';
import { openStudio } from './studioShell.js';
import type { AvailableShellPayload } from './types.js';

export interface StudioStartCallbacks {
  openNewTerminal(shell?: string): Promise<void>;
  openSettings(): void;
  launchGameStudio(): void;
}

let callbacks: StudioStartCallbacks = {
  openNewTerminal: async () => {},
  openSettings: () => {},
  launchGameStudio: () => {}
};

export function configureStudioStartCallbacks(cbs: StudioStartCallbacks): void {
  callbacks = cbs;
}

export function hydrateStartShellOptions(shells: AvailableShellPayload[]): void {
  const targets = [dom.startShellSelect, dom.termShellSelect];
  for (const sel of targets) {
    if (!sel) continue;
    const prev = sel.value;
    sel.textContent = '';
    for (const sh of shells) {
      const opt = document.createElement('option');
      opt.value = sh.id;
      opt.textContent = sh.label;
      if (sh.isDefault) opt.selected = true;
      sel.appendChild(opt);
    }
    if (prev && shells.some((s) => s.id === prev)) {
      sel.value = prev;
    }
  }
}

function applyPlatformShortcutLabels(): void {
  const isMac = /mac/i.test(navigator.platform || navigator.userAgent || '');
  if (dom.startKbdFiles) dom.startKbdFiles.textContent = isMac ? '⌘⌥P' : 'Ctrl+Alt+P';
  if (dom.startKbdTerminal) dom.startKbdTerminal.textContent = isMac ? '⌃`' : 'Ctrl+`';
  if (dom.startKbdBrowser) dom.startKbdBrowser.textContent = isMac ? '⌘⌥T' : 'Ctrl+Alt+T';
}

export function bindStudioStartEvents(): void {
  applyPlatformShortcutLabels();

  dom.startFilesBtn?.addEventListener('click', () => {
    openStudio('files');
    dom.fileFilterEl.focus();
  });

  dom.startTerminalBtn?.addEventListener('click', () => {
    const selectedShell = dom.startShellSelect?.value || undefined;
    openStudio('terminal');
    void callbacks.openNewTerminal(selectedShell);
  });

  dom.startShellSelect?.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  dom.startBrowserBtn?.addEventListener('click', () => {
    openStudio('browser');
    dom.browserUrlInput.focus();
  });

  dom.startMoreBtn?.addEventListener('click', () => {
    const shelf = dom.startMoreShelf;
    if (!shelf || !dom.startMoreBtn) return;
    const nextOpen = !shelf.classList.contains('open');
    shelf.classList.toggle('open', nextOpen);
    dom.startMoreBtn.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
  });

  dom.startEditorBtn?.addEventListener('click', () => {
    openStudio('canvas');
    dom.filePathInput.focus();
  });
  dom.startDiffBtn?.addEventListener('click', () => openStudio('diff'));
  dom.startCliBtn?.addEventListener('click', () => {
    openStudio('cli');
    dom.cliCmdInput.focus();
  });
  dom.startGameBtn?.addEventListener('click', () => callbacks.launchGameStudio());
  dom.startSettingsBtn?.addEventListener('click', () => callbacks.openSettings());
}
