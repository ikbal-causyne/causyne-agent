import { dom, maybeById } from './dom.js';
import type { AppState } from './types.js';

export const DRAFT_KEY = 'causyne/web/composerDraft/v1';
export const THEME_KEY = 'causyne/web/theme/v1';
export const PERMISSION_PRESET_KEY = 'causyne/web/permissionPreset/v1';
export const LEGACY_MODE_KEY = 'causyne/web/autonomyMode/v1';
export const STUDIO_WIDTH_KEY = 'causyne/web/studioWidth/v1';
export const DEFAULT_STUDIO_W = 480;

const hashParams = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
export const TOKEN_STORE_KEY = `causyne/web/token:${window.location.origin}`;

let sessionToken = hashParams.get('token') || '';
if (sessionToken) {
  try { window.sessionStorage.setItem(TOKEN_STORE_KEY, sessionToken); } catch { /* ignore */ }
  try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch { /* ignore */ }
} else {
  try { sessionToken = window.sessionStorage.getItem(TOKEN_STORE_KEY) || ''; } catch { /* ignore */ }
}

let apiBase = '';
try {
  const qs = new URLSearchParams(window.location.search || '');
  const bridge = (qs.get('bridge') || '').trim();
  if (bridge) {
    const parsed = new URL(bridge);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol === 'http:' && (host === '127.0.0.1' || host === 'localhost')) {
      apiBase = parsed.origin;
    }
  }
} catch {
  // Ignore invalid bridge parameter.
}

export function apiUrl(p: string): string {
  return apiBase + p;
}

export function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return Object.assign({ Authorization: `Bearer ${sessionToken}` }, extra || {});
}

export const state: AppState = {
  sessionId: null,
  sessions: [],
  models: null,
  modelTab: null,
  modelQuery: '',
  modelExpandedPeers: new Set<string>(),
  modelSelectedIndex: 0,
  modelRefreshing: false,
  modelLiveHydrated: false,
  modelNotice: '',
  activeProvider: 'unconfigured',
  activeModel: 'default',
  permissionPreset: 'workspace-write',
  defaultPermissionPreset: 'workspace-write',
  workspaceRoot: '',
  lastScrollTop: 0,
  attachments: [],
  currentDir: '',
  parentDir: '',
  studioTab: 'start',
  studioSplit: false,
  studioSecondaryTab: 'terminal',
  studioExpanded: false,
  studioWidth: DEFAULT_STUDIO_W,
  terminalSessions: [],
  activeTerminalId: null,
  availableShells: [],
  canvasPreviewMode: false,
  canvasDirty: false,
  artifactVersions: new Map(),
  sessionWorkspaces: new Map(),
  sessionSwitchSeq: 0,
  usageTokens: 0,
  diffScope: 'session',
  browserEngine: 'agent',
  browserMode: 'empty',
  browserUrl: '',
  browserSrcdoc: '',
  browserViewport: 'desktop',
  liveBrowserActive: false,
  liveBrowserVisible: false,
  liveBrowserRuntime: null,
  liveBrowserPref: 'auto',
  liveStreamMode: 'idle',
  liveStreamAbort: null,
  liveStreamConnected: false,
  liveFps: 0,
  pointerDragging: false,
  liveBrowserWidth: 1280,
  liveBrowserHeight: 800,
  controlOwner: 'human',
  cliCommands: [],
  mentionMode: 'file',
  mentionItems: [],
  mentionIndex: 0,
  mentionStart: -1,
  diffStaged: false,
  isComposing: false,
  stickToBottom: true,
  activeController: null,
  activeTurn: null,
  activePrompt: '',
  gameStatus: null,
  gameLaunching: false
};

export function setLiveness(active: boolean, label: string): void {
  const isActive = Boolean(active);
  dom.livenessPill.classList.toggle('active', isActive);
  dom.appEl.classList.toggle('is-processing', isActive);
  if (label) dom.livenessText.textContent = label;
  if (state.activeTurn && typeof state.activeTurn.setActivity === 'function') {
    state.activeTurn.setActivity(isActive, label || 'Thinking...');
  }
}

export function applyTheme(theme: string): void {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  if (dom.themeToggleBtn) dom.themeToggleBtn.textContent = next === 'light' ? 'Dark' : 'Light';
  try { window.localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
}

export function clampStudioWidth(raw: unknown): number {
  const n = Number(raw);
  const sidebarW = dom.appEl.classList.contains('sidebar-collapsed') || window.innerWidth <= 960 ? 0 : 256;
  const minW = 320;
  const maxByChat = Math.max(minW, window.innerWidth - sidebarW - 360);
  const maxW = Math.max(minW, Math.min(Math.floor(window.innerWidth * 0.72), maxByChat));
  const base = Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_STUDIO_W;
  return Math.max(minW, Math.min(maxW, base));
}

export function syncExpandedStudioWidth(): void {
  const sidebarW = dom.appEl.classList.contains('sidebar-collapsed') || window.innerWidth <= 960 ? 0 : 256;
  const available = Math.max(360, window.innerWidth - sidebarW - 380);
  const expandedW = Math.min(1040, Math.max(360, available));
  document.documentElement.style.setProperty('--studio-expanded-w', `${expandedW}px`);
}

export function applyStudioWidth(px: number | string, persist: boolean): void {
  const clamped = clampStudioWidth(px);
  state.studioWidth = clamped;
  document.documentElement.style.setProperty('--studio-w', `${clamped}px`);
  syncExpandedStudioWidth();
  if (dom.studioRoot) {
    dom.studioRoot.style.flexBasis = '';
    dom.studioRoot.style.width = '';
  }
  if (persist) {
    try { window.localStorage.setItem(STUDIO_WIDTH_KEY, String(clamped)); } catch { /* ignore */ }
  }
}

export function setStageMode(hasMessages: boolean): void {
  dom.stageEl.classList.toggle('is-empty', !hasMessages);
  dom.stageEl.classList.toggle('has-messages', hasMessages);
}

export function updateComposerMetrics(): void {
  dom.promptInput.style.height = 'auto';
  const nextH = Math.min(200, Math.max(26, dom.promptInput.scrollHeight));
  dom.promptInput.style.height = `${nextH}px`;
  const hasText = Boolean((dom.promptInput.value || '').trim());
  const streaming = state.activeController !== null;
  dom.sendBtn.classList.toggle('ready', !streaming && hasText);
  dom.sendBtn.classList.toggle('stopping', streaming);
  dom.sendBtn.setAttribute('aria-label', streaming ? 'Stop response' : 'Send message');
  const iconSend = maybeById('icon-send');
  const iconStop = maybeById('icon-stop');
  if (iconSend) iconSend.style.display = streaming ? 'none' : 'block';
  if (iconStop) iconStop.style.display = streaming ? 'block' : 'none';
  try {
    if (dom.promptInput.value) window.localStorage.setItem(DRAFT_KEY, dom.promptInput.value);
    else window.localStorage.removeItem(DRAFT_KEY);
  } catch { /* ignore */ }
}

export function scrollToBottom(force: boolean, smooth = false): void {
  if (!dom.threadWrapEl) return;
  if (force || state.stickToBottom) {
    if (smooth && typeof dom.threadWrapEl.scrollTo === 'function') {
      dom.threadWrapEl.scrollTo({ top: dom.threadWrapEl.scrollHeight, behavior: 'smooth' });
    } else {
      dom.threadWrapEl.scrollTop = dom.threadWrapEl.scrollHeight;
    }
    state.lastScrollTop = dom.threadWrapEl.scrollTop;
    state.stickToBottom = true;
    dom.scrollBottomBtn.classList.remove('visible');
  }
}

export function syncUsagePill(tokens: number): void {
  state.usageTokens = Number(tokens) > 0 ? Number(tokens) : 0;
  if (dom.usagePill) {
    if (state.usageTokens > 0) {
      dom.usagePill.textContent = `${state.usageTokens.toLocaleString()} tok`;
      dom.usagePill.classList.add('visible');
    } else {
      dom.usagePill.textContent = '';
      dom.usagePill.classList.remove('visible');
    }
  }
}

export function restorePersistedPreferences(): void {
  try {
    const savedTheme = window.localStorage.getItem(THEME_KEY);
    if (savedTheme === 'light' || savedTheme === 'dark') applyTheme(savedTheme);
    const savedPreset = window.localStorage.getItem(PERMISSION_PRESET_KEY);
    if (savedPreset === 'read-only' || savedPreset === 'workspace-write' || savedPreset === 'danger-full-access') {
      state.permissionPreset = savedPreset;
      state.defaultPermissionPreset = savedPreset;
    } else {
      const legacyMode = window.localStorage.getItem(LEGACY_MODE_KEY);
      if (legacyMode === 'A') state.permissionPreset = 'read-only';
      else if (legacyMode === 'C') state.permissionPreset = 'danger-full-access';
      else if (legacyMode === 'B') state.permissionPreset = 'workspace-write';
      state.defaultPermissionPreset = state.permissionPreset;
    }
    const savedDraft = window.localStorage.getItem(DRAFT_KEY);
    if (savedDraft) dom.promptInput.value = savedDraft;
    const savedW = window.localStorage.getItem(STUDIO_WIDTH_KEY);
    if (savedW) applyStudioWidth(savedW, false);
  } catch { /* ignore */ }

  if (window.innerWidth <= 960) dom.appEl.classList.add('sidebar-collapsed');
}
