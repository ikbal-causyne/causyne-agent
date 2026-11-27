import { announceStatus, dom } from './dom.js';
import { apiUrl, authHeaders, state } from './state.js';
import { closeAllPopovers, positionPopover } from './studioShell.js';
import type { AssistantTurnHandle, ModelPickerItem, ModelsResponse } from './types.js';

export interface ModelPickerCallbacks {
  createErrorTurn(message: string): AssistantTurnHandle | void;
}

let callbacks: ModelPickerCallbacks = {
  createErrorTurn: () => {}
};

export function configureModelPickerCallbacks(cbs: ModelPickerCallbacks): void {
  callbacks = cbs;
}

export async function loadHealth(): Promise<void> {
  const res = await fetch(apiUrl('/api/health'), { headers: authHeaders() });
  if (!res.ok) {
    dom.wsNameEl.textContent = 'Auth required';
    dom.wsMetaEl.textContent = 'Open URL printed by causyne web';
    callbacks.createErrorTurn('Missing or invalid Skybridge token. Open the URL printed by `causyne web`.');
    return;
  }
  const data = await res.json() as {
    provider?: string;
    model?: string;
    workspaceRoot?: string;
    workspaceName?: string;
    version?: string;
  };
  state.activeProvider = data.provider || 'unconfigured';
  state.activeModel = data.model || 'default';
  state.workspaceRoot = data.workspaceRoot || '';
  dom.wsNameEl.textContent = data.workspaceName || 'Workspace';
  dom.wsMetaEl.textContent = `v${data.version || ''}`;
  if (dom.settingsWsPath) dom.settingsWsPath.textContent = data.workspaceRoot || '';
  const cleanModel = String(state.activeModel || '').split('/').pop() || state.activeProvider;
  dom.modelTriggerName.textContent = cleanModel === 'default' ? state.activeProvider : cleanModel;
}

function updateModelRefreshUi(): void {
  const btn = dom.modelPopover.querySelector<HTMLButtonElement>('.mp-refresh-btn');
  if (!btn) return;
  btn.disabled = state.modelRefreshing;
  btn.textContent = state.modelRefreshing ? 'Refreshing...' : 'Refresh';
}

async function selectModel(provider: string, model: string): Promise<void> {
  closeAllPopovers();
  const res = await fetch(apiUrl('/api/model'), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ provider, model })
  });
  if (!res.ok) return;
  const data = await res.json() as { provider?: string; model?: string };
  state.activeProvider = data.provider || provider;
  state.activeModel = data.model || model;
  const cleanModel = String(state.activeModel || '').split('/').pop() || state.activeProvider;
  dom.modelTriggerName.textContent = cleanModel === 'default' ? state.activeProvider : cleanModel;
  announceStatus(`Switched model to ${cleanModel}`);
  void loadModels();
}

async function disconnectOpenRouterAccount(): Promise<void> {
  const res = await fetch(apiUrl('/api/model'), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ action: 'disconnect', provider: 'openrouter' })
  });
  if (!res.ok) return;
  const data = await res.json() as { provider?: string; model?: string };
  state.activeProvider = data.provider || state.activeProvider;
  state.activeModel = data.model || state.activeModel;
  state.modelNotice = 'Disconnected OpenRouter account.';
  await loadModels();
}

function fuzzyMatchModelItem(item: ModelPickerItem, query: string): boolean {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const hay = [
    item.label || '',
    item.category || '',
    item.id || '',
    item.description || '',
    item.value?.providerLabel || ''
  ].join(' ').toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    if (hay.includes(tok)) continue;
    let ti = 0;
    for (let hi = 0; hi < hay.length && ti < tok.length; hi += 1) {
      if (hay[hi] === tok[ti]) ti += 1;
    }
    if (ti < tok.length) return false;
  }
  return true;
}

function getVisibleModelItems(): ModelPickerItem[] {
  if (!state.models || !state.models.tabs) return [];
  const tab = state.modelTab || state.models.initialTab || 'acp';
  const rawItems = Array.isArray(state.models.tabs[tab]) ? state.models.tabs[tab] : [];
  const q = String(state.modelQuery || '').trim();
  if (q) {
    return rawItems.filter((item) => !(item.value && item.value.isToggle) && fuzzyMatchModelItem(item, q));
  }
  if (tab !== 'acp') return rawItems;
  const MAX_ACP = 10;
  const byPeer = new Map<string, ModelPickerItem[]>();
  const orderedPeers: string[] = [];
  for (const item of rawItems) {
    const key = item.value?.providerId || item.category || 'peer';
    let list = byPeer.get(key);
    if (!list) {
      list = [];
      byPeer.set(key, list);
      orderedPeers.push(key);
    }
    list.push(item);
  }
  const out: ModelPickerItem[] = [];
  for (const key of orderedPeers) {
    const peerItems = byPeer.get(key) || [];
    const installedModels = peerItems.filter((it) => it.value?.installed && !it.value?.isToggle);
    if (installedModels.length <= MAX_ACP) {
      for (const it of peerItems) out.push(it);
      continue;
    }
    const expanded = state.modelExpandedPeers.has(key);
    const slice = expanded ? installedModels : installedModels.slice(0, MAX_ACP);
    for (const it of slice) out.push(it);
    const first = installedModels[0];
    out.push({
      id: key + (expanded ? ':__load_less__' : ':__load_more__'),
      label: expanded
        ? `Show fewer (top ${MAX_ACP})`
        : `Show ${installedModels.length - MAX_ACP} more models...`,
      category: first?.category || '',
      description: expanded ? 'collapse' : 'expand',
      value: {
        type: 'toggle',
        isToggle: true,
        action: expanded ? 'collapse' : 'expand',
        peerKey: key,
        providerId: key,
        modelId: '',
        providerLabel: first?.value?.providerLabel || key,
        installed: true,
        isCurrent: false,
        isConfigured: true
      }
    });
  }
  return out;
}

function activateModelPickerItem(item: ModelPickerItem | undefined): void {
  if (!item || !item.value) return;
  const v = item.value;
  if (v.isToggle && v.peerKey) {
    if (state.modelExpandedPeers.has(v.peerKey)) state.modelExpandedPeers.delete(v.peerKey);
    else state.modelExpandedPeers.add(v.peerKey);
    renderModelListOnly(false);
    return;
  }
  if (v.type === 'action' && v.action === 'disconnect' && v.providerId === 'openrouter') {
    void disconnectOpenRouterAccount();
    return;
  }
  if (v.type === 'acp' && !v.installed) {
    state.modelNotice = v.setupInstruction || `${v.providerLabel || 'Peer'} is not installed on PATH yet.`;
    renderModelListOnly(false);
    return;
  }
  if ((v.type === 'byok' || v.type === 'free') && !v.isConfigured && v.providerId !== 'ollama') {
    closeAllPopovers();
    dom.settingsModal.classList.add('open');
    if (dom.vaultProviderSelect && v.providerId) {
      const opt = Array.from(dom.vaultProviderSelect.options).find((o) => o.value === v.providerId);
      if (opt) dom.vaultProviderSelect.value = v.providerId;
    }
    dom.vaultStatusEl.textContent = `Add your ${v.envVar || `${v.providerLabel || v.providerId || 'provider'} API key`} to use ${v.modelId || 'this model'}.`;
    dom.vaultKeyInput.focus();
    return;
  }
  state.modelNotice = '';
  if (v.providerId) void selectModel(v.providerId, v.modelId || '');
}

function switchModelTab(nextTab: 'acp' | 'byok' | 'free'): void {
  if (state.modelTab === nextTab) return;
  state.modelTab = nextTab;
  state.modelSelectedIndex = 0;
  state.modelNotice = '';
  renderModelPopover();
}

export function ensureModelPickerShell(): void {
  if (dom.modelPopover.querySelector('.mp-head')) return;
  dom.modelPopover.textContent = '';
  const head = document.createElement('div');
  head.className = 'mp-head';
  const topRow = document.createElement('div');
  topRow.className = 'mp-top-row';
  const tabsEl = document.createElement('div');
  tabsEl.className = 'mp-tabs';
  tabsEl.setAttribute('role', 'tablist');
  const tabDefs: ReadonlyArray<{ id: 'acp' | 'byok' | 'free'; label: string }> = [
    { id: 'acp', label: 'ACP' },
    { id: 'byok', label: 'BYOK' },
    { id: 'free', label: 'FREE' }
  ];
  for (const def of tabDefs) {
    const tb = document.createElement('button');
    tb.type = 'button';
    tb.className = 'mp-tab';
    tb.setAttribute('role', 'tab');
    tb.dataset.mptab = def.id;
    tb.textContent = def.label;
    tb.addEventListener('click', () => switchModelTab(def.id));
    tabsEl.appendChild(tb);
  }
  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'mp-refresh-btn';
  refreshBtn.textContent = 'Refresh';
  refreshBtn.addEventListener('click', () => { void loadModels('refresh'); });
  topRow.appendChild(tabsEl);
  topRow.appendChild(refreshBtn);

  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'mp-search';
  searchInput.placeholder = 'Filter models (e.g. gemini, sonnet, deepseek)...';
  searchInput.setAttribute('aria-label', 'Filter models');
  searchInput.addEventListener('input', () => {
    state.modelQuery = searchInput.value || '';
    state.modelSelectedIndex = 0;
    renderModelListOnly(false);
  });
  searchInput.addEventListener('keydown', (e) => {
    const items = getVisibleModelItems();
    const tabOrder: ReadonlyArray<'acp' | 'byok' | 'free'> = ['acp', 'byok', 'free'];
    const curTabIdx = Math.max(0, tabOrder.indexOf(state.modelTab || 'acp'));
    if (e.key === 'Tab') {
      e.preventDefault();
      const nextIdx = (curTabIdx + (e.shiftKey ? 2 : 1)) % 3;
      switchModelTab(tabOrder[nextIdx] || 'acp');
      return;
    }
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !searchInput.value) {
      e.preventDefault();
      const nextIdx = e.key === 'ArrowRight' ? Math.min(2, curTabIdx + 1) : Math.max(0, curTabIdx - 1);
      switchModelTab(tabOrder[nextIdx] || 'acp');
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (items.length > 0) {
        state.modelSelectedIndex = (state.modelSelectedIndex + 1) % items.length;
        renderModelListOnly(true);
      }
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length > 0) {
        state.modelSelectedIndex = (state.modelSelectedIndex - 1 + items.length) % items.length;
        renderModelListOnly(true);
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (items.length > 0) {
        const chosen = items[Math.min(state.modelSelectedIndex, items.length - 1)];
        activateModelPickerItem(chosen);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeAllPopovers();
    }
  });

  head.appendChild(topRow);
  head.appendChild(searchInput);
  const noteEl = document.createElement('div');
  noteEl.className = 'mp-note';
  noteEl.style.display = 'none';
  const listEl = document.createElement('div');
  listEl.className = 'mp-list';
  const footEl = document.createElement('div');
  footEl.className = 'mp-foot';
  const footLeft = document.createElement('span');
  footLeft.textContent = 'Tab switch · ↑↓ navigate · Enter select';
  const footCount = document.createElement('span');
  footCount.className = 'mp-foot-count';
  footEl.appendChild(footLeft);
  footEl.appendChild(footCount);
  dom.modelPopover.appendChild(head);
  dom.modelPopover.appendChild(noteEl);
  dom.modelPopover.appendChild(listEl);
  dom.modelPopover.appendChild(footEl);
}

function renderModelListOnly(scrollFocused: boolean): void {
  const listEl = dom.modelPopover.querySelector<HTMLElement>('.mp-list');
  const noteEl = dom.modelPopover.querySelector<HTMLElement>('.mp-note');
  const footCount = dom.modelPopover.querySelector<HTMLElement>('.mp-foot-count');
  if (!listEl) return;
  if (noteEl) {
    if (state.modelNotice) {
      noteEl.textContent = state.modelNotice;
      noteEl.style.display = 'block';
    } else {
      noteEl.textContent = '';
      noteEl.style.display = 'none';
    }
  }
  listEl.textContent = '';
  const items = getVisibleModelItems();
  if (state.modelSelectedIndex >= items.length) state.modelSelectedIndex = Math.max(0, items.length - 1);
  const selectableCount = items.filter((it) => !(it.value && (it.value.isToggle || it.value.type === 'action'))).length;
  if (footCount) footCount.textContent = `${selectableCount}${selectableCount === 1 ? ' model' : ' models'}`;
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'mp-empty';
    empty.textContent = state.modelQuery ? 'No models matched your search in this tab.' : 'Loading models...';
    listEl.appendChild(empty);
    return;
  }
  let currentCategory = '';
  let focusedBtn: HTMLButtonElement | null = null;
  items.forEach((item, idx) => {
    if (item.category && item.category !== currentCategory) {
      currentCategory = item.category;
      const cat = document.createElement('div');
      cat.className = 'mp-cat';
      cat.textContent = currentCategory;
      listEl.appendChild(cat);
    }
    const v = item.value || {};
    const btn = document.createElement('button');
    btn.type = 'button';
    const isFocused = idx === state.modelSelectedIndex;
    const isCurrent = Boolean(v.isCurrent);
    const isMuted = (v.type === 'acp' && !v.installed)
      || ((v.type === 'byok' || v.type === 'free') && !v.isConfigured && v.providerId !== 'ollama');
    const isDanger = v.type === 'action' && v.action === 'disconnect';
    btn.className = 'mp-row'
      + (isFocused ? ' focused' : '')
      + (isCurrent ? ' current' : '')
      + (v.isToggle ? ' toggle' : '')
      + (isMuted ? ' muted' : '')
      + (isDanger ? ' danger' : '');
    btn.title = item.id || item.label || '';
    const lbl = document.createElement('span');
    lbl.className = 'mp-row-label';
    lbl.textContent = item.label || '';
    const st = document.createElement('span');
    st.className = `mp-row-status${isCurrent ? ' is-active' : (v.installed && v.isConfigured ? ' is-ready' : '')}`;
    st.textContent = item.description || '';
    btn.appendChild(lbl);
    btn.appendChild(st);
    btn.addEventListener('mouseenter', () => { state.modelSelectedIndex = idx; });
    btn.addEventListener('click', () => activateModelPickerItem(item));
    listEl.appendChild(btn);
    if (isFocused) focusedBtn = btn;
  });
  if (scrollFocused && focusedBtn) (focusedBtn as HTMLButtonElement).scrollIntoView({ block: 'nearest' });
}

export function renderModelPopover(): void {
  ensureModelPickerShell();
  const activeTab = state.modelTab || state.models?.initialTab || 'acp';
  state.modelTab = activeTab;
  const tabsData = state.models?.tabs || {};
  dom.modelPopover.querySelectorAll<HTMLButtonElement>('.mp-tab').forEach((tb) => {
    const id = tb.dataset.mptab || '';
    const isSelected = id === activeTab;
    tb.classList.toggle('active', isSelected);
    tb.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    const list = Array.isArray(tabsData[id]) ? tabsData[id] : [];
    const hasActive = list.some((it) => Boolean(it?.value?.isCurrent));
    tb.textContent = '';
    if (hasActive) {
      const dot = document.createElement('span');
      dot.className = 'mp-tab-dot';
      tb.appendChild(dot);
    }
    tb.appendChild(document.createTextNode(id === 'acp' ? 'ACP' : (id === 'byok' ? 'BYOK' : 'FREE')));
  });
  const searchInput = dom.modelPopover.querySelector<HTMLInputElement>('.mp-search');
  if (searchInput && searchInput.value !== state.modelQuery) searchInput.value = state.modelQuery;
  updateModelRefreshUi();
  renderModelListOnly(false);
}

export async function loadModels(mode?: string): Promise<void> {
  const isRefresh = mode === 'refresh';
  const isLive = mode === 'live';
  if (isRefresh || isLive) {
    state.modelRefreshing = true;
    updateModelRefreshUi();
  }
  const qs = isRefresh ? '?refresh=1' : (isLive ? '?live=1' : '');
  try {
    const res = await fetch(apiUrl(`/api/models${qs}`), { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json() as ModelsResponse;
    state.models = data;
    if (!state.modelTab) state.modelTab = data.initialTab || 'acp';
    if (data.activeProvider) state.activeProvider = data.activeProvider;
    if (data.activeModel) state.activeModel = data.activeModel;
    renderModelPopover();
    if (!isRefresh && !isLive && !state.modelLiveHydrated) {
      state.modelLiveHydrated = true;
      void loadModels('live');
    }
  } finally {
    if (isRefresh || isLive) {
      state.modelRefreshing = false;
      updateModelRefreshUi();
    }
  }
}

export function bindModelPickerEvents(): void {
  dom.modelTriggerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = dom.modelPopover.classList.contains('open');
    closeAllPopovers();
    if (!wasOpen) {
      state.modelQuery = '';
      state.modelNotice = '';
      state.modelSelectedIndex = 0;
      dom.modelTriggerBtn.setAttribute('aria-expanded', 'true');
      renderModelPopover();
      positionPopover(dom.modelPopover, dom.modelTriggerBtn, false);
      const searchInput = dom.modelPopover.querySelector<HTMLInputElement>('.mp-search');
      if (searchInput) searchInput.focus();
      void loadModels();
    }
  });
}
