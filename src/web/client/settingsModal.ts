import { dom } from './dom.js';
import {
  apiUrl,
  applyAutoScrollPref,
  applyDensity,
  applyTheme,
  authHeaders,
  isAutoScrollEnabled
} from './state.js';
import { isSafeBillingUrl } from './validators.js';

export type SettingsSectionId =
  | 'general'
  | 'configuration'
  | 'personalization'
  | 'billing'
  | 'vault'
  | 'mcp'
  | 'hooks'
  | 'plugins'
  | 'diagnostics';

type PersonalizationScope = 'project' | 'global';

interface LicenseStatusPayload {
  entitlement?: string;
  plan?: string;
  paidUntil?: string | null;
  dailySeconds?: number | null;
  remainingSeconds?: number | null;
  recoveryCode?: string | null;
  supportMessage?: string;
  error?: string;
}

interface PersonalizationDoc {
  scope: PersonalizationScope;
  path: string;
  displayPath: string;
  exists: boolean;
  content: string;
  bytes: number;
  maxBytes: number;
}

interface PersonalizationPayload {
  workspaceRoot: string;
  project: PersonalizationDoc;
  global: PersonalizationDoc;
  memory: {
    enabled: boolean;
    allowToolAssisted: boolean;
    source: 'project' | 'global';
    projectOverrides: { enabled?: boolean; allowToolAssisted?: boolean };
    globalDefaults: { enabled: boolean; allowToolAssisted: boolean };
  };
  memoryStats: {
    projectFacts: number;
    totalFacts: number;
    projectObservations: number;
    totalObservations: number;
    projectSummaries: number;
    totalSummaries: number;
  };
  activeRules: Array<{
    scope: string;
    label: string;
    bytes: number;
    truncated?: boolean;
  }>;
}

interface HookOverviewItem {
  index: number;
  name: string;
  event: string;
  tools: string[];
  commandPreview: string;
  timeoutMs: number;
  enabled: boolean;
}

interface PluginOverviewItem {
  name: string;
  version?: string;
  description?: string;
  enabled: boolean;
  modified?: boolean;
  invalid?: boolean;
  error?: string;
  capabilities?: string[];
}

interface McpServerOverviewItem {
  name: string;
  transport: string;
  target: string;
  granted?: boolean;
  connected?: boolean;
  status?: string;
  error?: string;
  tools?: string[];
}

interface SettingsOverviewPayload {
  ok?: boolean;
  general?: {
    workspaceRoot?: string;
    workspaceName?: string;
    version?: string;
    platform?: string;
    provider?: string;
    model?: string;
  };
  configuration?: {
    defaultPermissionPreset?: string;
    reasoningEffort?: string;
    osSandbox?: {
      configuredMode?: string;
      effectiveMode?: string;
      strict?: boolean;
      backend?: string;
      available?: boolean;
      reason?: string;
    };
    tokenBudget?: {
      enabled?: boolean;
      maxTokensPerTask?: number;
      maxTokensPerDay?: number;
      maxCostUsd?: number;
      hardStop?: boolean;
    };
    autoCompact?: {
      enabled?: boolean;
      thresholdPercent?: number;
    };
  };
  personalization?: PersonalizationPayload;
  vault?: {
    activeProvider?: string;
    configuredProviders?: string[];
  };
  mcp?: {
    servers?: McpServerOverviewItem[];
    projectDiscovered?: McpServerOverviewItem[];
    projectWarnings?: string[];
    projectFile?: string | null;
  };
  hooks?: HookOverviewItem[];
  plugins?: {
    root?: string;
    items?: PluginOverviewItem[];
  };
}

export interface SettingsModalCallbacks {
  loadHealth(): Promise<void>;
  loadModels(mode?: string): Promise<void>;
}

const SECTION_LABELS: Record<SettingsSectionId, string> = {
  general: 'General',
  configuration: 'Configuration',
  personalization: 'Personalization',
  billing: 'Usage & billing',
  vault: 'API keys',
  mcp: 'MCP servers',
  hooks: 'Hooks',
  plugins: 'Plugins',
  diagnostics: 'Diagnostics'
};

let callbacks: SettingsModalCallbacks = {
  loadHealth: async () => {},
  loadModels: async () => {}
};

let activeSection: SettingsSectionId = 'general';
let activeScope: PersonalizationScope = 'project';
let overviewData: SettingsOverviewPayload | null = null;
const savedInstructions: Record<PersonalizationScope, string> = { project: '', global: '' };
const draftInstructions: Record<PersonalizationScope, string> = { project: '', global: '' };

export function configureSettingsModalCallbacks(cbs: SettingsModalCallbacks): void {
  callbacks = cbs;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function clearChildren(el: HTMLElement | null): void {
  if (!el) return;
  while (el.firstChild) el.removeChild(el.firstChild);
}

function makePill(text: string, variant?: 'ok' | 'warn'): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = variant === 'ok'
    ? 'settings-pill is-ok'
    : variant === 'warn'
      ? 'settings-pill is-warn'
      : 'settings-pill';
  span.textContent = text;
  return span;
}

function makeEmptyBox(text: string): HTMLDivElement {
  const div = document.createElement('div');
  div.className = 'settings-empty-box';
  div.textContent = text;
  return div;
}

function makeSwitchControl(
  checked: boolean,
  ariaLabel: string,
  onChange: (nextChecked: boolean, inputEl: HTMLInputElement) => void
): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'c-switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.setAttribute('aria-label', ariaLabel);
  input.addEventListener('change', () => onChange(input.checked, input));
  const track = document.createElement('span');
  track.className = 'c-switch-track';
  label.appendChild(input);
  label.appendChild(track);
  return label;
}

function syncDeleteConfirmVisibility(confirming: boolean): void {
  if (dom.personalizationMemoryDeleteBtn) dom.personalizationMemoryDeleteBtn.hidden = confirming;
  if (dom.personalizationMemoryConfirmBtn) dom.personalizationMemoryConfirmBtn.hidden = !confirming;
  if (dom.personalizationMemoryCancelBtn) dom.personalizationMemoryCancelBtn.hidden = !confirming;
}

export function selectSettingsSection(section: SettingsSectionId): void {
  activeSection = section;
  const navButtons = dom.settingsModal.querySelectorAll<HTMLButtonElement>('[data-settings-section]');
  navButtons.forEach((btn) => {
    const isMatch = btn.dataset.settingsSection === section;
    btn.classList.toggle('active', isMatch);
    btn.setAttribute('aria-selected', isMatch ? 'true' : 'false');
  });
  const panes = dom.settingsModal.querySelectorAll<HTMLElement>('[data-settings-pane]');
  panes.forEach((pane) => {
    const isMatch = pane.dataset.settingsPane === section;
    pane.classList.toggle('active', isMatch);
    pane.hidden = !isMatch;
  });
  if (dom.settingsMobileTitle) {
    dom.settingsMobileTitle.textContent = SECTION_LABELS[section] || 'Settings';
  }
  if (section === 'diagnostics') {
    void loadDoctorReport();
  } else if (section === 'billing') {
    void loadLicenseStatus(false);
  }
}

function updatePersonalizationSaveState(): void {
  if (!dom.personalizationInstructionsInput || !dom.personalizationSaveBtn) return;
  const current = dom.personalizationInstructionsInput.value;
  draftInstructions[activeScope] = current;
  const bytes = utf8ByteLength(current);
  const maxBytes = overviewData?.personalization?.[activeScope]?.maxBytes ?? 16_384;
  if (dom.personalizationByteCount) {
    dom.personalizationByteCount.textContent = `${bytes.toLocaleString()} / ${maxBytes.toLocaleString()} bytes`;
    dom.personalizationByteCount.style.color = bytes > maxBytes ? 'var(--err)' : '';
  }
  const dirty = current !== savedInstructions[activeScope];
  dom.personalizationSaveBtn.disabled = !dirty || bytes > maxBytes;
}

function renderPersonalizationView(): void {
  const p = overviewData?.personalization;
  if (!p) return;

  if (dom.settingsPersonalizationDot) {
    dom.settingsPersonalizationDot.hidden = !(p.project.exists && p.project.content.trim().length > 0);
  }

  const isProject = activeScope === 'project';
  dom.personalizationScopeProjectBtn?.classList.toggle('active', isProject);
  dom.personalizationScopeGlobalBtn?.classList.toggle('active', !isProject);

  const doc = isProject ? p.project : p.global;
  if (dom.personalizationDocTitle) {
    dom.personalizationDocTitle.textContent = isProject ? 'Project instructions' : 'Global instructions';
  }
  if (dom.personalizationDocDesc) {
    dom.personalizationDocDesc.textContent = isProject
      ? 'Applies specifically to this project (.causyne/personalization.md) and is treated by Causyne Agent as a high-priority binding contract. Repository rules (CAUSYNE.md, AGENTS.md, .causyne/rules/) also apply.'
      : 'Applies across all projects on this computer (~/.causyne/CAUSYNE.md). Project-specific personalization overrides global defaults when both are set.';
  }
  if (dom.personalizationFilePath) {
    dom.personalizationFilePath.textContent = doc.displayPath;
  }
  if (dom.personalizationInstructionsInput) {
    dom.personalizationInstructionsInput.value = draftInstructions[activeScope];
  }
  updatePersonalizationSaveState();

  clearChildren(dom.personalizationActiveRules);
  if (dom.personalizationActiveRules) {
    if (p.activeRules.length === 0) {
      dom.personalizationActiveRules.appendChild(makePill('No active project rule files yet'));
    } else {
      for (const rule of p.activeRules) {
        const chip = makePill(
          `${rule.scope}: ${rule.label} (${rule.bytes.toLocaleString()} B)`,
          rule.scope === 'personalization' ? 'ok' : undefined
        );
        dom.personalizationActiveRules.appendChild(chip);
      }
    }
  }

  const memEnabled = isProject
    ? (typeof p.memory.projectOverrides.enabled === 'boolean' ? p.memory.projectOverrides.enabled : p.memory.globalDefaults.enabled)
    : p.memory.globalDefaults.enabled;
  const memToolAssisted = isProject
    ? (typeof p.memory.projectOverrides.allowToolAssisted === 'boolean' ? p.memory.projectOverrides.allowToolAssisted : p.memory.globalDefaults.allowToolAssisted)
    : p.memory.globalDefaults.allowToolAssisted;

  if (dom.personalizationMemoryEnabled) dom.personalizationMemoryEnabled.checked = memEnabled;
  if (dom.personalizationMemoryToolAssisted) dom.personalizationMemoryToolAssisted.checked = memToolAssisted;

  if (dom.personalizationMemoryDesc) {
    if (isProject) {
      dom.personalizationMemoryDesc.textContent = p.memory.source === 'project'
        ? 'Using project-specific memory settings for this workspace.'
        : 'Inheriting global memory defaults for this workspace (toggling sets a project override).';
    } else {
      dom.personalizationMemoryDesc.textContent = 'Default Causyne memory behavior across all projects on this computer.';
    }
  }
  if (dom.personalizationMemEnableDesc) {
    dom.personalizationMemEnableDesc.textContent = isProject
      ? 'Create memories from chats in this project and use them to personalize future chats'
      : 'Create memories from chats on this computer and use them to personalize future chats';
  }
  if (dom.personalizationMemDeleteDesc) {
    dom.personalizationMemDeleteDesc.textContent = isProject
      ? 'Delete stored Causyne memories for this project'
      : 'Delete all Causyne memories stored across every project on this computer';
  }
  if (dom.personalizationMemoryStats) {
    const s = p.memoryStats;
    dom.personalizationMemoryStats.textContent = isProject
      ? `${s.projectFacts} facts · ${s.projectObservations} observations`
      : `${s.totalFacts} facts · ${s.totalObservations} observations`;
  }
  syncDeleteConfirmVisibility(false);
}

function renderConfigurationView(): void {
  const cfg = overviewData?.configuration;
  if (!cfg) return;

  if (dom.settingsPermSelect && cfg.defaultPermissionPreset) {
    dom.settingsPermSelect.value = cfg.defaultPermissionPreset;
  }
  if (dom.settingsOsSandboxSelect && cfg.osSandbox?.configuredMode) {
    dom.settingsOsSandboxSelect.value = cfg.osSandbox.configuredMode;
  }
  if (dom.settingsSandboxBadge && cfg.osSandbox) {
    const sb = cfg.osSandbox;
    const label = sb.available
      ? `${sb.backend === 'seatbelt' ? 'Seatbelt' : sb.backend === 'bubblewrap' ? 'Bubblewrap' : sb.backend} ready`
      : 'Unavailable';
    dom.settingsSandboxBadge.textContent = label;
    dom.settingsSandboxBadge.className = sb.available ? 'settings-pill is-ok' : 'settings-pill is-warn';
  }
  if (dom.settingsSandboxDesc && cfg.osSandbox?.reason) {
    dom.settingsSandboxDesc.textContent = cfg.osSandbox.reason;
  }
  if (dom.settingsEffortSelect) {
    dom.settingsEffortSelect.value = cfg.reasoningEffort || '';
  }
  if (cfg.tokenBudget) {
    if (dom.settingsBudgetEnabled) dom.settingsBudgetEnabled.checked = cfg.tokenBudget.enabled === true;
    if (dom.settingsBudgetHardstop) dom.settingsBudgetHardstop.checked = cfg.tokenBudget.hardStop === true;
    if (dom.settingsBudgetTask) dom.settingsBudgetTask.value = String(cfg.tokenBudget.maxTokensPerTask ?? 150000);
    if (dom.settingsBudgetDay) dom.settingsBudgetDay.value = String(cfg.tokenBudget.maxTokensPerDay ?? 1000000);
    if (dom.settingsBudgetCost) dom.settingsBudgetCost.value = String(cfg.tokenBudget.maxCostUsd ?? 5);
  }
  if (cfg.autoCompact) {
    if (dom.settingsAutoCompactEnabled) dom.settingsAutoCompactEnabled.checked = cfg.autoCompact.enabled !== false;
    if (dom.settingsCompactPct) dom.settingsCompactPct.value = String(cfg.autoCompact.thresholdPercent ?? 78);
  }
}

function renderVaultConfiguredChips(): void {
  clearChildren(dom.vaultConfiguredList);
  if (!dom.vaultConfiguredList) return;
  const list = overviewData?.vault?.configuredProviders || [];
  if (list.length === 0) {
    dom.vaultConfiguredList.appendChild(makePill('No BYOK provider keys saved yet'));
    return;
  }
  for (const id of list) {
    dom.vaultConfiguredList.appendChild(makePill(id, 'ok'));
  }
}

function renderMcpView(): void {
  clearChildren(dom.settingsMcpList);
  if (!dom.settingsMcpList) return;
  const servers = overviewData?.mcp?.servers || [];
  const discovered = overviewData?.mcp?.projectDiscovered || [];

  if (servers.length === 0 && discovered.length === 0) {
    dom.settingsMcpList.appendChild(
      makeEmptyBox('No MCP servers configured yet. Add servers with `/mcp add` in the CLI or define a workspace `.mcp.json` file.')
    );
    return;
  }

  for (const srv of servers) {
    const card = document.createElement('div');
    card.className = 'settings-entity-card';
    const main = document.createElement('div');
    main.className = 'settings-entity-main';
    const nameRow = document.createElement('div');
    nameRow.className = 'settings-entity-name';
    nameRow.textContent = srv.name;
    nameRow.appendChild(makePill(srv.transport || 'stdio'));
    const statusText = srv.connected ? `connected · ${(srv.tools || []).length} tools` : (srv.status || 'disconnected');
    nameRow.appendChild(makePill(statusText, srv.connected ? 'ok' : undefined));
    const meta = document.createElement('div');
    meta.className = 'settings-entity-meta';
    meta.textContent = srv.error ? `${srv.target} — ${srv.error}` : (srv.target || 'Configured server');
    main.appendChild(nameRow);
    main.appendChild(meta);
    card.appendChild(main);
    dom.settingsMcpList.appendChild(card);
  }

  for (const srv of discovered) {
    if (servers.some((existing) => existing.name === srv.name)) continue;
    const card = document.createElement('div');
    card.className = 'settings-entity-card';
    const main = document.createElement('div');
    main.className = 'settings-entity-main';
    const nameRow = document.createElement('div');
    nameRow.className = 'settings-entity-name';
    nameRow.textContent = srv.name;
    nameRow.appendChild(makePill('workspace .mcp.json', 'warn'));
    const meta = document.createElement('div');
    meta.className = 'settings-entity-meta';
    meta.textContent = srv.target || 'Requires trust grant before launch';
    main.appendChild(nameRow);
    main.appendChild(meta);
    card.appendChild(main);
    dom.settingsMcpList.appendChild(card);
  }
}

function renderHooksView(): void {
  clearChildren(dom.settingsHooksList);
  if (!dom.settingsHooksList) return;
  const hooks = overviewData?.hooks || [];
  if (hooks.length === 0) {
    dom.settingsHooksList.appendChild(
      makeEmptyBox('No lifecycle hooks configured. Add `hooks` entries (PreToolUse / PostToolUse) in `~/.causyne/config.json` to inspect or toggle them here.')
    );
    return;
  }

  for (const hook of hooks) {
    const card = document.createElement('div');
    card.className = 'settings-entity-card';
    const main = document.createElement('div');
    main.className = 'settings-entity-main';
    const nameRow = document.createElement('div');
    nameRow.className = 'settings-entity-name';
    nameRow.textContent = hook.name;
    nameRow.appendChild(makePill(hook.event));
    nameRow.appendChild(makePill(hook.tools.join(', ')));
    const meta = document.createElement('div');
    meta.className = 'settings-entity-meta';
    meta.textContent = hook.commandPreview || `${hook.timeoutMs} ms timeout`;
    main.appendChild(nameRow);
    main.appendChild(meta);
    card.appendChild(main);
    card.appendChild(makeSwitchControl(hook.enabled, `Toggle hook ${hook.name}`, (nextEnabled, inputEl) => {
      void toggleHookEnabled(hook.index, nextEnabled, inputEl);
    }));
    dom.settingsHooksList.appendChild(card);
  }
}

function renderPluginsView(): void {
  if (dom.settingsPluginsRoot && overviewData?.plugins?.root) {
    dom.settingsPluginsRoot.textContent = `Plugin directory: ${overviewData.plugins.root}`;
  }
  clearChildren(dom.settingsPluginsList);
  if (!dom.settingsPluginsList) return;
  const items = overviewData?.plugins?.items || [];
  if (items.length === 0) {
    dom.settingsPluginsList.appendChild(
      makeEmptyBox('No local plugins installed. Place a plugin directory with `plugin.json` in the plugin root and enable trust here or via `/plugins enable <name>`.')
    );
    return;
  }

  for (const plugin of items) {
    const card = document.createElement('div');
    card.className = 'settings-entity-card';
    const main = document.createElement('div');
    main.className = 'settings-entity-main';
    const nameRow = document.createElement('div');
    nameRow.className = 'settings-entity-name';
    nameRow.textContent = plugin.version ? `${plugin.name} v${plugin.version}` : plugin.name;
    if (plugin.invalid) {
      nameRow.appendChild(makePill('invalid', 'warn'));
    } else if (plugin.modified) {
      nameRow.appendChild(makePill('modified · trust revoked', 'warn'));
    } else {
      nameRow.appendChild(makePill(plugin.enabled ? 'enabled' : 'disabled', plugin.enabled ? 'ok' : undefined));
    }
    const meta = document.createElement('div');
    meta.className = 'settings-entity-meta';
    const caps = Array.isArray(plugin.capabilities) && plugin.capabilities.length > 0
      ? `Capabilities: ${plugin.capabilities.join(', ')}`
      : 'No extra capabilities';
    meta.textContent = plugin.error || plugin.description || caps;
    main.appendChild(nameRow);
    main.appendChild(meta);
    card.appendChild(main);

    if (!plugin.invalid) {
      card.appendChild(makeSwitchControl(plugin.enabled && !plugin.modified, `Toggle plugin ${plugin.name}`, (nextEnabled, inputEl) => {
        void togglePluginEnabled(plugin.name, nextEnabled, inputEl);
      }));
    }
    dom.settingsPluginsList.appendChild(card);
  }
}

function renderGeneralMeta(): void {
  const gen = overviewData?.general;
  if (dom.settingsCompactToggle) {
    dom.settingsCompactToggle.checked = document.documentElement.getAttribute('data-density') === 'compact';
  }
  if (dom.settingsAutoScrollToggle) {
    dom.settingsAutoScrollToggle.checked = isAutoScrollEnabled();
  }
  if (!gen) return;
  if (dom.settingsWsPath && gen.workspaceRoot) {
    dom.settingsWsPath.textContent = gen.workspaceRoot;
  }
  if (dom.settingsRuntimeMeta) {
    dom.settingsRuntimeMeta.textContent = `${gen.provider || 'unconfigured'} · ${gen.model || 'default'} · ${gen.platform || 'local'}`;
  }
  if (dom.settingsVersionPill && gen.version) {
    dom.settingsVersionPill.textContent = `v${gen.version}`;
  }
}

export async function loadSettingsOverview(): Promise<void> {
  const res = await fetch(apiUrl('/api/settings/overview'), { headers: authHeaders() }).catch(() => null);
  if (!res || !res.ok) return;
  const data = await res.json().catch(() => null) as SettingsOverviewPayload | null;
  if (!data) return;
  overviewData = data;
  if (data.personalization) {
    savedInstructions.project = data.personalization.project.content;
    savedInstructions.global = data.personalization.global.content;
    draftInstructions.project = data.personalization.project.content;
    draftInstructions.global = data.personalization.global.content;
  }
  renderGeneralMeta();
  renderConfigurationView();
  renderPersonalizationView();
  renderVaultConfiguredChips();
  renderMcpView();
  renderHooksView();
  renderPluginsView();
}

async function saveConfigurationSettings(): Promise<void> {
  if (dom.settingsConfigStatus) dom.settingsConfigStatus.textContent = 'Saving configuration...';
  const payload = {
    defaultPermissionPreset: dom.settingsPermSelect?.value,
    osSandbox: dom.settingsOsSandboxSelect?.value,
    reasoningEffort: dom.settingsEffortSelect?.value ?? '',
    tokenBudget: {
      enabled: Boolean(dom.settingsBudgetEnabled?.checked),
      hardStop: Boolean(dom.settingsBudgetHardstop?.checked),
      maxTokensPerTask: Number(dom.settingsBudgetTask?.value || 150000),
      maxTokensPerDay: Number(dom.settingsBudgetDay?.value || 1000000),
      maxCostUsd: Number(dom.settingsBudgetCost?.value || 5)
    },
    autoCompact: {
      enabled: Boolean(dom.settingsAutoCompactEnabled?.checked),
      thresholdPercent: Number(dom.settingsCompactPct?.value || 78)
    }
  };
  const res = await fetch(apiUrl('/api/settings/configuration'), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload)
  }).catch(() => null);
  if (!res || !res.ok) {
    const err = await res?.json().catch(() => ({ error: 'Could not save configuration.' })) as { error?: string } | null;
    if (dom.settingsConfigStatus) dom.settingsConfigStatus.textContent = err?.error || 'Could not save configuration.';
    return;
  }
  const updated = await res.json().catch(() => null) as SettingsOverviewPayload | null;
  if (updated) {
    overviewData = updated;
    renderConfigurationView();
  }
  if (dom.settingsConfigStatus) dom.settingsConfigStatus.textContent = 'Configuration saved.';
  void callbacks.loadHealth();
}

async function savePersonalizationText(): Promise<void> {
  if (!dom.personalizationInstructionsInput) return;
  const content = dom.personalizationInstructionsInput.value;
  if (dom.personalizationStatusMsg) dom.personalizationStatusMsg.textContent = 'Saving...';
  const res = await fetch(apiUrl('/api/settings/personalization'), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ scope: activeScope, instructions: content })
  }).catch(() => null);
  if (!res || !res.ok) {
    const err = await res?.json().catch(() => ({ error: 'Could not save personalization.' })) as { error?: string } | null;
    if (dom.personalizationStatusMsg) dom.personalizationStatusMsg.textContent = err?.error || 'Could not save personalization.';
    return;
  }
  const data = await res.json().catch(() => null) as { personalization?: PersonalizationPayload } | null;
  if (data?.personalization && overviewData) {
    overviewData.personalization = data.personalization;
    savedInstructions[activeScope] = data.personalization[activeScope].content;
    draftInstructions[activeScope] = data.personalization[activeScope].content;
    renderPersonalizationView();
  }
  if (dom.personalizationStatusMsg) {
    dom.personalizationStatusMsg.textContent = activeScope === 'project'
      ? 'Saved to .causyne/personalization.md — active immediately for this project.'
      : 'Saved to ~/.causyne/CAUSYNE.md — active across all projects.';
  }
}

async function saveMemoryTogglePatch(patch: { memoryEnabled?: boolean; allowToolAssisted?: boolean }): Promise<void> {
  if (dom.personalizationMemoryStatus) dom.personalizationMemoryStatus.textContent = 'Updating memory preference...';
  const res = await fetch(apiUrl('/api/settings/personalization'), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ scope: activeScope, ...patch })
  }).catch(() => null);
  if (!res || !res.ok) {
    if (dom.personalizationMemoryStatus) dom.personalizationMemoryStatus.textContent = 'Could not update memory setting.';
    void loadSettingsOverview();
    return;
  }
  const data = await res.json().catch(() => null) as { personalization?: PersonalizationPayload } | null;
  if (data?.personalization && overviewData) {
    overviewData.personalization = data.personalization;
    renderPersonalizationView();
  }
  if (dom.personalizationMemoryStatus) {
    dom.personalizationMemoryStatus.textContent = activeScope === 'project'
      ? 'Project memory settings updated.'
      : 'Global memory defaults updated.';
  }
}

async function confirmDeleteMemories(): Promise<void> {
  const deleteScope = activeScope === 'global' ? 'all' : 'project';
  if (dom.personalizationMemoryStatus) dom.personalizationMemoryStatus.textContent = 'Deleting memories...';
  const res = await fetch(apiUrl('/api/settings/memories/delete'), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ scope: deleteScope })
  }).catch(() => null);
  syncDeleteConfirmVisibility(false);
  if (!res || !res.ok) {
    if (dom.personalizationMemoryStatus) dom.personalizationMemoryStatus.textContent = 'Could not delete memories.';
    return;
  }
  const data = await res.json().catch(() => null) as {
    factsRemoved?: number;
    observationsRemoved?: number;
    summariesRemoved?: number;
    personalization?: PersonalizationPayload;
  } | null;
  if (data?.personalization && overviewData) {
    overviewData.personalization = data.personalization;
    renderPersonalizationView();
  }
  if (dom.personalizationMemoryStatus) {
    const f = data?.factsRemoved ?? 0;
    const o = data?.observationsRemoved ?? 0;
    const s = data?.summariesRemoved ?? 0;
    dom.personalizationMemoryStatus.textContent =
      `Deleted ${f} fact${f === 1 ? '' : 's'}, ${o} observation${o === 1 ? '' : 's'}, and ${s} summar${s === 1 ? 'y' : 'ies'}.`;
  }
}

async function toggleHookEnabled(index: number, enabled: boolean, inputEl: HTMLInputElement): Promise<void> {
  if (dom.settingsHooksStatus) dom.settingsHooksStatus.textContent = 'Updating hook...';
  const res = await fetch(apiUrl('/api/settings/hooks/toggle'), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ index, enabled })
  }).catch(() => null);
  if (!res || !res.ok) {
    inputEl.checked = !enabled;
    if (dom.settingsHooksStatus) dom.settingsHooksStatus.textContent = 'Could not update hook state.';
    return;
  }
  const data = await res.json().catch(() => null) as { hooks?: HookOverviewItem[] } | null;
  if (data?.hooks && overviewData) {
    overviewData.hooks = data.hooks;
    renderHooksView();
  }
  if (dom.settingsHooksStatus) dom.settingsHooksStatus.textContent = enabled ? 'Hook enabled.' : 'Hook disabled.';
}

async function togglePluginEnabled(name: string, enabled: boolean, inputEl: HTMLInputElement): Promise<void> {
  if (dom.settingsPluginsStatus) dom.settingsPluginsStatus.textContent = `${enabled ? 'Enabling' : 'Disabling'} ${name}...`;
  const res = await fetch(apiUrl('/api/settings/plugins/toggle'), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name, enabled })
  }).catch(() => null);
  if (!res || !res.ok) {
    inputEl.checked = !enabled;
    if (dom.settingsPluginsStatus) dom.settingsPluginsStatus.textContent = `Could not update plugin ${name}.`;
    return;
  }
  const data = await res.json().catch(() => null) as { plugins?: { root?: string; items?: PluginOverviewItem[] } } | null;
  if (data?.plugins && overviewData) {
    overviewData.plugins = data.plugins;
    renderPluginsView();
  }
  if (dom.settingsPluginsStatus) dom.settingsPluginsStatus.textContent = enabled ? `Enabled ${name}.` : `Disabled ${name}.`;
}

export async function loadDoctorReport(): Promise<void> {
  dom.doctorPre.textContent = 'Loading redacted diagnostics...';
  const res = await fetch(apiUrl('/api/doctor/report'), { headers: authHeaders() });
  if (!res.ok) { dom.doctorPre.textContent = 'Unable to load diagnostics.'; return; }
  const data = await res.json() as { report?: string };
  dom.doctorPre.textContent = data.report || 'No diagnostics available.';
}

export async function loadLicenseStatus(forceLive: boolean): Promise<void> {
  if (!dom.licenseSummaryEl) return;
  dom.licenseSummaryEl.textContent = 'Checking plan status...';
  const qs = forceLive ? '?live=1' : '';
  const res = await fetch(apiUrl(`/api/license/status${qs}`), { headers: authHeaders() }).catch(() => null);
  if (!res) { dom.licenseSummaryEl.textContent = 'Could not load plan status.'; return; }
  const data = await res.json().catch(() => null) as LicenseStatusPayload | null;
  if (!res.ok || !data) {
    dom.licenseSummaryEl.textContent = (data && data.error) || 'Licensing service offline.';
    return;
  }
  const isPro = data.entitlement === 'pro' && Boolean(data.paidUntil);
  if (dom.licenseBadgeEl) {
    dom.licenseBadgeEl.textContent = isPro ? (`Pro · ${data.plan || 'active'}`) : 'Free · 6h/day';
    dom.licenseBadgeEl.classList.toggle('is-pro', isPro);
  }
  if (dom.licensePortalBtn) dom.licensePortalBtn.style.display = isPro ? 'inline-flex' : 'none';
  if (isPro) {
    const untilStr = String(data.paidUntil).slice(0, 10);
    dom.licenseSummaryEl.textContent = `Unlimited daily execution · Paid through ${untilStr}`;
    if (dom.licenseMeterWrap) dom.licenseMeterWrap.style.display = 'none';
    if (dom.licenseSupportNote) {
      dom.licenseSupportNote.textContent = data.recoveryCode
        ? `Thank you for supporting Causyne! Save your multi-device recovery code: ${data.recoveryCode}`
        : 'Thank you for supporting independent Causyne development and community maintenance.';
    }
  } else {
    const daySec = Number(data.dailySeconds || 21600);
    const remSec = typeof data.remainingSeconds === 'number' ? Math.max(0, data.remainingSeconds) : daySec;
    const remMin = Math.floor(remSec / 60);
    const dayMin = Math.floor(daySec / 60);
    const pct = daySec > 0 ? Math.max(0, Math.min(100, Math.round((remSec / daySec) * 100))) : 100;
    dom.licenseSummaryEl.textContent = `${remMin} of ${dayMin} free active minutes remaining today (resets 00:00 UTC)`;
    if (dom.licenseMeterWrap) dom.licenseMeterWrap.style.display = 'block';
    if (dom.licenseMeterFill) dom.licenseMeterFill.style.width = `${pct}%`;
    if (dom.licenseSupportNote) {
      dom.licenseSupportNote.textContent = remSec <= 0 && data.supportMessage
        ? data.supportMessage
        : 'Free includes 6 hours/day of active execution. Upgrade to Causyne Pro for unlimited daily usage and to support independent development, ongoing maintenance, and making Causyne Agent better for the entire community. Thank you for your trust and support.';
    }
  }
}

async function startLicenseCheckout(): Promise<void> {
  if (!dom.licensePlanSelect || !dom.licenseStatusMsg) return;
  const plan = dom.licensePlanSelect.value || 'monthly';
  dom.licenseStatusMsg.textContent = 'Opening secure checkout...';
  const res = await fetch(apiUrl('/api/license/checkout'), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ plan })
  }).catch(() => null);
  if (!res) { dom.licenseStatusMsg.textContent = 'Could not reach checkout service.'; return; }
  const data = await res.json().catch(() => ({ error: 'Checkout error' })) as { url?: string; error?: string };
  if (!res.ok || !data.url || !isSafeBillingUrl(data.url)) {
    dom.licenseStatusMsg.textContent = data.error || 'Checkout unavailable right now. Visit causyne.com/pricing.html.';
    return;
  }
  window.open(data.url, '_blank', 'noopener,noreferrer');
  dom.licenseStatusMsg.textContent = 'Checkout opened in a new tab. Click Refresh after payment completes.';
}

async function claimLicenseRecovery(): Promise<void> {
  if (!dom.licenseRecoveryInput || !dom.licenseStatusMsg) return;
  const code = (dom.licenseRecoveryInput.value || '').trim();
  if (!code) { dom.licenseStatusMsg.textContent = 'Enter your CSYN-XXXX-XXXX-XXXX-XXXX recovery code first.'; return; }
  dom.licenseStatusMsg.textContent = 'Linking license...';
  const res = await fetch(apiUrl('/api/license/recover'), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ recoveryCode: code })
  }).catch(() => null);
  if (!res) { dom.licenseStatusMsg.textContent = 'Could not reach licensing service.'; return; }
  const data = await res.json().catch(() => ({ error: 'Recovery failed' })) as { error?: string };
  if (!res.ok) { dom.licenseStatusMsg.textContent = data.error || 'Could not link recovery code.'; return; }
  dom.licenseRecoveryInput.value = '';
  dom.licenseStatusMsg.textContent = 'Causyne Pro linked to this device!';
  void loadLicenseStatus(true);
}

async function openBillingPortal(): Promise<void> {
  if (!dom.licenseStatusMsg) return;
  dom.licenseStatusMsg.textContent = 'Opening billing portal...';
  const res = await fetch(apiUrl('/api/license/portal'), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: '{}'
  }).catch(() => null);
  if (!res) { dom.licenseStatusMsg.textContent = 'Could not open billing portal.'; return; }
  const data = await res.json().catch(() => ({ error: 'Portal unavailable' })) as { url?: string; error?: string };
  if (!res.ok || !data.url || !isSafeBillingUrl(data.url)) {
    dom.licenseStatusMsg.textContent = data.error || 'Billing portal unavailable.';
    return;
  }
  window.open(data.url, '_blank', 'noopener,noreferrer');
  dom.licenseStatusMsg.textContent = 'Billing portal opened in a new tab.';
}

async function saveVaultApiKey(): Promise<void> {
  const provider = dom.vaultProviderSelect.value;
  const apiKey = (dom.vaultKeyInput.value || '').trim();
  if (!apiKey) { dom.vaultStatusEl.textContent = 'Enter an API key first.'; return; }
  dom.vaultStatusEl.textContent = 'Saving...';
  const res = await fetch(apiUrl('/api/config/key'), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ provider, apiKey, activate: true })
  }).catch(() => null);
  dom.vaultKeyInput.value = '';
  if (!res || !res.ok) { dom.vaultStatusEl.textContent = 'Could not save key.'; return; }
  const data = await res.json() as { provider?: string };
  dom.vaultStatusEl.textContent = `Saved for ${data.provider || provider}.`;
  void callbacks.loadHealth();
  void callbacks.loadModels();
  void loadSettingsOverview();
}

export function openSettingsModal(initialSection?: SettingsSectionId): void {
  dom.settingsModal.classList.add('open');
  if (initialSection) {
    selectSettingsSection(initialSection);
  } else {
    selectSettingsSection(activeSection);
  }
  void loadSettingsOverview();
  void loadLicenseStatus(false);
}

export function bindSettingsModalEvents(): void {
  dom.navSettingsBtn.addEventListener('click', () => openSettingsModal());
  dom.settingsCloseBtn.addEventListener('click', () => dom.settingsModal.classList.remove('open'));
  dom.settingsModal.addEventListener('click', (e) => {
    if (e.target === dom.settingsModal) dom.settingsModal.classList.remove('open');
  });

  const navButtons = dom.settingsModal.querySelectorAll<HTMLButtonElement>('[data-settings-section]');
  navButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.settingsSection as SettingsSectionId | undefined;
      if (target && Object.prototype.hasOwnProperty.call(SECTION_LABELS, target)) {
        selectSettingsSection(target);
      }
    });
  });

  dom.themeToggleBtn.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'dark';
    applyTheme(cur === 'light' ? 'dark' : 'light');
  });
  dom.settingsCompactToggle?.addEventListener('change', () => {
    applyDensity(dom.settingsCompactToggle?.checked ? 'compact' : 'comfortable');
  });
  dom.settingsAutoScrollToggle?.addEventListener('change', () => {
    applyAutoScrollPref(Boolean(dom.settingsAutoScrollToggle?.checked));
  });

  dom.settingsConfigSaveBtn?.addEventListener('click', () => { void saveConfigurationSettings(); });

  dom.personalizationScopeProjectBtn?.addEventListener('click', () => {
    activeScope = 'project';
    if (dom.personalizationStatusMsg) dom.personalizationStatusMsg.textContent = '';
    if (dom.personalizationMemoryStatus) dom.personalizationMemoryStatus.textContent = '';
    renderPersonalizationView();
  });
  dom.personalizationScopeGlobalBtn?.addEventListener('click', () => {
    activeScope = 'global';
    if (dom.personalizationStatusMsg) dom.personalizationStatusMsg.textContent = '';
    if (dom.personalizationMemoryStatus) dom.personalizationMemoryStatus.textContent = '';
    renderPersonalizationView();
  });
  dom.personalizationInstructionsInput?.addEventListener('input', () => {
    updatePersonalizationSaveState();
  });
  dom.personalizationInstructionsInput?.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (!dom.personalizationSaveBtn?.disabled) void savePersonalizationText();
    }
  });
  dom.personalizationSaveBtn?.addEventListener('click', () => { void savePersonalizationText(); });

  dom.personalizationMemoryEnabled?.addEventListener('change', () => {
    void saveMemoryTogglePatch({ memoryEnabled: Boolean(dom.personalizationMemoryEnabled?.checked) });
  });
  dom.personalizationMemoryToolAssisted?.addEventListener('change', () => {
    void saveMemoryTogglePatch({ allowToolAssisted: Boolean(dom.personalizationMemoryToolAssisted?.checked) });
  });
  dom.personalizationMemoryDeleteBtn?.addEventListener('click', () => {
    syncDeleteConfirmVisibility(true);
  });
  dom.personalizationMemoryCancelBtn?.addEventListener('click', () => {
    syncDeleteConfirmVisibility(false);
  });
  dom.personalizationMemoryConfirmBtn?.addEventListener('click', () => {
    void confirmDeleteMemories();
  });

  dom.settingsMcpRefreshBtn?.addEventListener('click', () => { void loadSettingsOverview(); });
  dom.doctorLoadBtn.addEventListener('click', () => { void loadDoctorReport(); });
  dom.vaultSaveBtn.addEventListener('click', () => { void saveVaultApiKey(); });
  if (dom.licenseUpgradeBtn) dom.licenseUpgradeBtn.addEventListener('click', () => { void startLicenseCheckout(); });
  if (dom.licensePortalBtn) dom.licensePortalBtn.addEventListener('click', () => { void openBillingPortal(); });
  if (dom.licenseRefreshBtn) dom.licenseRefreshBtn.addEventListener('click', () => { void loadLicenseStatus(true); });
  if (dom.licenseRecoverBtn) dom.licenseRecoverBtn.addEventListener('click', () => { void claimLicenseRecovery(); });
}
