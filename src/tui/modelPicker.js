// Sovereign Interactive Model Picker — modal dialog for ACP & BYOK models.
//
// Pure Node over ./dialogs.js, ../dynamicCatalogue.js, and ../config.js.
// No shell, zero malware, source-available under BUSL-1.1.
// @ts-expect-error untyped local TUI dialogs
import { SelectLayer, InputLayer } from './dialogs.js';
// @ts-expect-error untyped local TUI theme
import { paint, bold, dim, GLYPHS } from './theme.js';
// @ts-expect-error untyped local TUI selectList
import { fuzzyFilter } from './selectList.js';
import { loadConfig, saveConfig } from '../config.js';
import { startLoopbackAuth, saveOpenRouterKey, disconnectOpenRouter } from '../auth/openrouterAuth.js';
import { setTransientNotice } from './consoleGuard.js';
import { getAvailableProvidersOverview, resolveAvailableProvidersOverview, resolveAvailableModels } from '../dynamicCatalogue.js';
async function showConfiguringAnimation(providerLabel, promptHost) {
    if (promptHost && typeof promptHost.scheduleDraw === 'function') {
        promptHost.notice = `Configuring ${providerLabel} in secure local vault…`;
        promptHost.scheduleDraw();
        await new Promise(r => setTimeout(r, 120));
        promptHost.notice = `✓ ${providerLabel} credentials saved.`;
        promptHost.scheduleDraw();
        return;
    }
    if (!process.stdout.isTTY)
        return;
    process.stdout.write(`\r\x1b[K  \x1b[32m✓\x1b[0m ${providerLabel} credentials saved.\n`);
}
/**
 * Build items for SelectLayer categorized by ACP peers and BYOK providers.
 *
 * Supports tab filtering ('acp' | 'byok' | 'all') and smart pagination
 * for ACP peers exceeding maxAcpPerPeer (default 10 models).
 */
export function buildModelPickerItems(config, overview, options = {}) {
    const items = [];
    const activeProvider = config.provider || '';
    const activeModel = config.model || '';
    const tab = options.tab || 'all';
    const expandedPeers = options.expandedPeers || new Set();
    const defaultMaxAcp = tab === 'all' ? Infinity : 10;
    let maxAcp = defaultMaxAcp;
    if (typeof options.maxAcpPerPeer === 'number') {
        if (options.maxAcpPerPeer === Infinity) {
            maxAcp = Infinity;
        }
        else if (Number.isFinite(options.maxAcpPerPeer)) {
            maxAcp = Math.max(1, Math.floor(options.maxAcpPerPeer));
        }
    }
    // 1. ACP Peer Agents & Sovereign Local Engines
    if (tab === 'all' || tab === 'acp') {
        for (const peer of overview.acp) {
            const isCurrentProvider = activeProvider === peer.providerKey;
            const catTitle = peer.installed
                ? `ACP · ${peer.label} (ready)`
                : `ACP · ${peer.label} (not installed)`;
            if (peer.installed && Array.isArray(peer.models) && peer.models.length > 0) {
                const isExpanded = expandedPeers.has(peer.providerKey) || peer.models.length <= maxAcp;
                const visibleModels = isExpanded ? peer.models : peer.models.slice(0, maxAcp);
                for (const m of visibleModels) {
                    const isCurrent = isCurrentProvider && activeModel === m;
                    items.push({
                        id: `${peer.providerKey}/${m}`,
                        label: m,
                        category: catTitle,
                        description: isCurrent ? '● active' : 'ready',
                        value: {
                            type: 'acp',
                            providerId: peer.providerKey,
                            modelId: m,
                            providerLabel: peer.label,
                            installed: true,
                            isCurrent,
                            isConfigured: true,
                            setupInstruction: peer.setupInstruction
                        }
                    });
                }
                // Toggle item: Load more / Load less for peers with > maxAcp models
                if (peer.models.length > maxAcp) {
                    if (!isExpanded) {
                        const remaining = peer.models.length - maxAcp;
                        items.push({
                            id: `${peer.providerKey}:__load_more__`,
                            label: `▶ Load more (${remaining} more models)...`,
                            category: catTitle,
                            description: 'expand',
                            value: {
                                type: 'toggle',
                                providerId: peer.providerKey,
                                modelId: '__load_more__',
                                providerLabel: peer.label,
                                installed: true,
                                isCurrent: false,
                                isConfigured: true,
                                isToggle: true,
                                action: 'expand',
                                peerKey: peer.providerKey
                            }
                        });
                    }
                    else {
                        items.push({
                            id: `${peer.providerKey}:__load_less__`,
                            label: `▲ Load less (show top ${maxAcp})...`,
                            category: catTitle,
                            description: 'collapse',
                            value: {
                                type: 'toggle',
                                providerId: peer.providerKey,
                                modelId: '__load_less__',
                                providerLabel: peer.label,
                                installed: true,
                                isCurrent: false,
                                isConfigured: true,
                                isToggle: true,
                                action: 'collapse',
                                peerKey: peer.providerKey
                            }
                        });
                    }
                }
            }
            else {
                // Uninstalled ACP agent: show entry so user can see it's supported
                items.push({
                    id: `${peer.providerKey}:uninstalled`,
                    label: peer.label,
                    category: catTitle,
                    description: 'not installed — setup needed',
                    value: {
                        type: 'acp',
                        providerId: peer.providerKey,
                        modelId: peer.models[0] || peer.id,
                        providerLabel: peer.label,
                        installed: false,
                        isCurrent: false,
                        isConfigured: false,
                        setupInstruction: peer.setupInstruction
                    }
                });
            }
        }
    }
    // 2. BYOK Providers (Cloud & Local APIs) — excluding OpenRouter in BYOK tab
    if (tab === 'all' || tab === 'byok') {
        for (const p of overview.byok) {
            if (p.id === 'openrouter') {
                continue;
            }
            const isCurrentProvider = activeProvider === p.id || (p.id === 'qwen' && activeProvider === 'dashscope-byok');
            const catTitle = p.id === 'ollama'
                ? `BYOK · ${p.label}`
                : `BYOK · ${p.label} ${p.isConfigured ? '(configured)' : '(needs key)'}`;
            const models = Array.isArray(p.models) && p.models.length > 0 ? p.models : [p.defaultModel];
            for (const m of models) {
                const isCurrent = isCurrentProvider && activeModel === m;
                const desc = isCurrent
                    ? '● active'
                    : p.id === 'ollama'
                        ? 'local'
                        : p.isConfigured
                            ? 'configured'
                            : 'needs API key';
                items.push({
                    id: `${p.id}/${m}`,
                    label: m,
                    category: catTitle,
                    description: desc,
                    value: {
                        type: 'byok',
                        providerId: p.id,
                        modelId: m,
                        providerLabel: p.label,
                        installed: true,
                        isCurrent,
                        isConfigured: p.isConfigured,
                        envVar: p.envVar
                    }
                });
            }
        }
    }
    // 3. Free Cloud Models (OpenRouter Free)
    if (tab === 'all' || tab === 'free') {
        const isConfigured = Boolean((config.provider === 'openrouter' && config.apiKey) ||
            config.providerKeys?.openrouter ||
            process.env.OPENROUTER_API_KEY);
        const isCurrentProvider = activeProvider === 'openrouter';
        const catTitle = isConfigured
            ? 'Free Cloud · OpenRouter (ready)'
            : 'Free Cloud · OpenRouter (connect account)';
        const isCurrent = isCurrentProvider && (activeModel === 'openrouter/free' || !activeModel);
        const desc = isCurrent
            ? '● active (free)'
            : (isConfigured ? 'free inference' : 'connect OpenRouter · free');
        // Canonical auto-routing free model (OpenRouter automatically routes free inference)
        items.push({
            id: 'openrouter/openrouter/free',
            label: 'openrouter/free',
            category: catTitle,
            description: desc,
            value: {
                type: 'free',
                providerId: 'openrouter',
                modelId: 'openrouter/free',
                providerLabel: 'OpenRouter Free',
                installed: true,
                isCurrent,
                isConfigured,
                envVar: 'OPENROUTER_API_KEY'
            }
        });
        // Provide first-class in-place Disconnect / Unlink action when configured
        if (isConfigured) {
            items.push({
                id: 'openrouter:disconnect',
                label: 'Disconnect OpenRouter (unlink account)',
                category: catTitle,
                description: 'unlink & remove key',
                value: {
                    type: 'action',
                    providerId: 'openrouter',
                    modelId: 'disconnect',
                    providerLabel: 'OpenRouter Free',
                    installed: true,
                    isCurrent: false,
                    isConfigured: true,
                    action: 'disconnect'
                }
            });
        }
    }
    return items;
}
/**
 * Sovereign Model Picker Layer with tri-tab support (| ACP | BYOK | FREE |)
 * and interactive 10-model pagination.
 */
export class ModelPickerLayer extends SelectLayer {
    activeTab;
    config;
    overview;
    expandedPeers;
    promptHost;
    allItems;
    constructor(options) {
        const activeProvider = (options.config.provider || '').toLowerCase().trim();
        const initialTab = activeProvider === 'openrouter'
            ? 'free'
            : (activeProvider === 'antigravity' ||
                activeProvider === 'agy' ||
                activeProvider === 'acp' ||
                activeProvider.startsWith('acp/')
                ? 'acp'
                : 'byok');
        const expandedPeers = new Set();
        const allItems = buildModelPickerItems(options.config, options.overview, { tab: 'all', maxAcpPerPeer: Infinity });
        super({
            title: 'Select Model',
            placeholder: 'type to filter (e.g. gemini, sonnet, openrouter)…',
            emptyText: 'No models matched your search in this tab',
            items: allItems,
            width: 78,
            height: 22,
            footer: 'tab / ← → switch tab  •  enter select  •  esc close',
            onPick: options.onPick
        });
        this.config = options.config;
        this.overview = options.overview;
        this.promptHost = options.promptHost;
        this.activeTab = initialTab;
        this.expandedPeers = expandedPeers;
        this.allItems = allItems;
        // Custom refilter ensuring list renders only activeTab while keeping allItems intact
        const self = this;
        this.list.refilter = function () {
            const isSearching = Boolean(this.query && this.query.trim());
            const tabItems = buildModelPickerItems(self.config, self.overview, {
                tab: self.activeTab,
                expandedPeers: self.expandedPeers,
                maxAcpPerPeer: isSearching ? Infinity : 10
            });
            this.filtered = fuzzyFilter(tabItems, this.query);
            this.selected = Math.min(this.selected || 0, Math.max(0, this.filtered.length - 1));
            this.offset = 0;
            return this;
        };
        // Initialize list with active tab items
        this.list.refilter();
    }
    updateOverview(freshOverview) {
        this.overview = freshOverview;
        this.allItems = buildModelPickerItems(this.config, this.overview, { tab: 'all', maxAcpPerPeer: Infinity });
        this.list.all = this.allItems;
        this.list.refilter();
        if (this.promptHost && typeof this.promptHost.scheduleDraw === 'function') {
            this.promptHost.scheduleDraw();
        }
    }
    switchTab(tab) {
        if (this.activeTab === tab)
            return;
        this.activeTab = tab;
        this.list.refilter();
        this.list.selected = 0;
        this.list.offset = 0;
        if (this.promptHost && typeof this.promptHost.scheduleDraw === 'function') {
            this.promptHost.scheduleDraw();
        }
    }
    togglePeerExpand(peerKey) {
        if (this.expandedPeers.has(peerKey)) {
            this.expandedPeers.delete(peerKey);
        }
        else {
            this.expandedPeers.add(peerKey);
        }
        const currentId = this.list.current?.id;
        this.list.refilter();
        if (currentId && Array.isArray(this.list.filtered)) {
            const idx = this.list.filtered.findIndex((entry) => entry?.item?.id === currentId || entry?.item?.value?.peerKey === peerKey);
            if (idx >= 0)
                this.list.selected = idx;
        }
        if (this.promptHost && typeof this.promptHost.scheduleDraw === 'function') {
            this.promptHost.scheduleDraw();
        }
    }
    preferredHeight() {
        const categories = new Set(this.list.filtered.map((entry) => entry.item?.category).filter(Boolean));
        return 2 + 2 + this.list.filtered.length + categories.size + 2;
    }
    body(width, height) {
        const tabACP = this.activeTab === 'acp' ? paint('accent', bold('● ACP')) : dim('ACP');
        const tabBYOK = this.activeTab === 'byok' ? paint('accent', bold('● BYOK')) : dim('BYOK');
        const tabFREE = this.activeTab === 'free' ? paint('accent', bold('● FREE')) : dim('FREE');
        const tabBar = `  | ${tabACP} | ${tabBYOK} | ${tabFREE} |   ${dim('(Tab / ← → switch tab)')}`;
        const separator = paint('rule', GLYPHS.hLine.repeat(Math.max(4, width)));
        const listHeight = Math.max(1, height - 2);
        const { rows } = this.list.render(width, listHeight);
        this.cursor = { x: this.list.cursorColumn(), y: 2 };
        return [tabBar, separator, ...rows];
    }
    key(event) {
        if (!event)
            return null;
        // 1. Tab switching via Tab, Left/Right arrows, or PgLeft/PgRight mappings
        if (event.name === 'tab') {
            if (this.activeTab === 'acp')
                this.switchTab('byok');
            else if (this.activeTab === 'byok')
                this.switchTab('free');
            else
                this.switchTab('acp');
            return 'handled';
        }
        if (event.name === 'left') {
            if (!this.list.query || event.alt || event.ctrl || event.meta) {
                if (this.activeTab === 'free') {
                    this.switchTab('byok');
                    return 'handled';
                }
                else if (this.activeTab === 'byok') {
                    this.switchTab('acp');
                    return 'handled';
                }
            }
        }
        if (event.name === 'right') {
            if (!this.list.query || event.alt || event.ctrl || event.meta) {
                if (this.activeTab === 'acp') {
                    this.switchTab('byok');
                    return 'handled';
                }
                else if (this.activeTab === 'byok') {
                    this.switchTab('free');
                    return 'handled';
                }
            }
        }
        if (event.name === '[' || (event.name === 'pageup' && (event.shift || event.alt || event.ctrl))) {
            if (this.activeTab === 'free')
                this.switchTab('byok');
            else if (this.activeTab === 'byok')
                this.switchTab('acp');
            return 'handled';
        }
        if (event.name === ']' || (event.name === 'pagedown' && (event.shift || event.alt || event.ctrl))) {
            if (this.activeTab === 'acp')
                this.switchTab('byok');
            else if (this.activeTab === 'byok')
                this.switchTab('free');
            return 'handled';
        }
        // 2. Delegate to SelectList for navigation / query typing
        const visibleRows = this.list.lastItemRows || Math.max(1, this.height - 7);
        const action = this.list.handleKey(event, visibleRows);
        if (action === 'select') {
            const item = this.list.current;
            if (item?.value?.isToggle && item?.value?.peerKey) {
                this.togglePeerExpand(item.value.peerKey);
                return 'handled';
            }
            this.settled = true;
            const result = this.onPick ? this.onPick(item) : null;
            if (result === 'keep')
                this.settled = false;
            return result === 'keep' ? 'handled' : 'close';
        }
        if (action === 'cancel')
            return 'close';
        return action ? 'handled' : null;
    }
}
/**
 * Run interactive model picker in the provided TUI prompt.
 *
 * Automatically handles:
 * - Dual-tab navigation (| ACP | BYOK |).
 * - Smart 10-model pagination per ACP peer with in-place Load more / Load less.
 * - Direct selection of ACP models without prompting for an API key.
 * - Direct selection of configured BYOK models without prompting for an API key.
 * - InputLayer modal prompt for API key when selecting an unconfigured BYOK model,
 *   safely encrypting it into ~/.causyne/config.json.
 * - Synchronous runtime loop re-initialization so the live session switches immediately.
 */
export async function runInteractiveModelPicker(prompt, store = { loadConfig, saveConfig }, options = {}) {
    if (!prompt || typeof prompt.openLayer !== 'function') {
        return 'Run causyne in an interactive terminal to use the model picker.';
    }
    const config = store.loadConfig();
    const overview = getAvailableProvidersOverview(config);
    const picked = await new Promise((resolve) => {
        const layer = new ModelPickerLayer({
            config,
            overview,
            promptHost: prompt,
            onPick: resolve
        });
        prompt.openLayer(layer);
        if (!process.env.NODE_TEST_CONTEXT) {
            void resolveAvailableProvidersOverview(config).then((freshOverview) => {
                if (layer.settled)
                    return;
                layer.updateOverview(freshOverview);
            }).catch(() => { });
        }
    });
    const notifyPrompt = (providerId, modelId) => {
        if (typeof prompt.updateModel === 'function') {
            prompt.updateModel(providerId, modelId);
        }
        else if (prompt.renderer?.status) {
            prompt.renderer.status.setSession({ provider: providerId, model: modelId });
            if (typeof prompt.scheduleDraw === 'function')
                prompt.scheduleDraw();
        }
    };
    if (!picked || !picked.value || picked.value.isToggle) {
        return 'Cancelled. Model was not changed.';
    }
    const target = picked.value;
    // Case 1: ACP Peer Agent or Antigravity
    if (target.type === 'acp') {
        if (!target.installed) {
            return (`△ Notice: "${target.providerLabel}" is not installed on this machine.\n` +
                `Setup: ${target.setupInstruction || 'Install the CLI binary.'}\n\n` +
                `Model was not changed.`);
        }
        config['provider'] = target.providerId;
        config['model'] = target.modelId;
        config['apiKey'] = '';
        delete config['baseUrl'];
        store.saveConfig(config);
        if (options.loop) {
            options.loop.config = config;
            if (typeof options.loop.updateTierLimits === 'function') {
                options.loop.updateTierLimits();
            }
        }
        notifyPrompt(target.providerId, target.modelId);
        return `Now using ${target.providerLabel} / ${target.modelId}.`;
    }
    // Case 2: Disconnect / Unlink action (e.g. Disconnect OpenRouter)
    if (target.action === 'disconnect' || target.modelId === 'disconnect') {
        const updatedConfig = disconnectOpenRouter(store);
        if (options.loop) {
            options.loop.config = updatedConfig;
            if (typeof options.loop.updateTierLimits === 'function') {
                options.loop.updateTierLimits();
            }
        }
        notifyPrompt(updatedConfig.provider || 'antigravity', updatedConfig.model || 'Gemini 3.8 Flash (Low)');
        return (`✓ Disconnected OpenRouter. Account and API credentials have been unlinked from Causyne Agent.\n` +
            `Active model reverted to ${updatedConfig.provider || 'antigravity'} / ${updatedConfig.model || 'Gemini 3.8 Flash (Low)'}.`);
    }
    // Case 3: OpenRouter Free Models with instant 1-Enter OAuth PKCE flow
    if (target.providerId === 'openrouter') {
        let existingKey = '';
        const providerKeys = config['providerKeys'] && typeof config['providerKeys'] === 'object' ? config['providerKeys'] : {};
        if (config['provider'] === 'openrouter' && typeof config['apiKey'] === 'string' && config['apiKey']) {
            existingKey = config['apiKey'];
        }
        else if (providerKeys['openrouter']) {
            existingKey = providerKeys['openrouter'];
        }
        else if (process.env.OPENROUTER_API_KEY) {
            existingKey = process.env.OPENROUTER_API_KEY;
        }
        if (existingKey) {
            config['provider'] = 'openrouter';
            config['model'] = target.modelId;
            config['apiKey'] = existingKey;
            config['providerKeys'] = providerKeys;
            config['providerKeys']['openrouter'] = existingKey;
            store.saveConfig(config);
            void resolveAvailableModels('openrouter', { ...config, apiKey: existingKey }, true).catch(() => { });
            if (options.loop) {
                options.loop.config = config;
                if (typeof options.loop.updateTierLimits === 'function') {
                    options.loop.updateTierLimits();
                }
            }
            notifyPrompt('openrouter', target.modelId);
            return `Now using OpenRouter Free / ${target.modelId}.`;
        }
        // Unconfigured OpenRouter: prompt where pressing Enter once immediately starts OAuth redirect
        const entered = await new Promise((resolve) => {
            const layer = new InputLayer({
                title: 'Connect OpenRouter · Free Cloud Inference',
                lines: [
                    'Press [Enter] to open your browser and authorize with OpenRouter.',
                    'Or paste an existing OpenRouter API key (Esc to cancel).'
                ],
                mask: false,
                placeholder: 'Press Enter to authorize in browser, or paste API key',
                onSubmit: resolve,
                onCancel: () => resolve(null)
            });
            prompt.openLayer(layer);
        });
        if (entered === null) {
            return 'Cancelled. OpenRouter connection was not completed. Model was not changed.';
        }
        const cleanInput = entered.trim();
        if (!cleanInput) {
            // User pressed Enter on empty placeholder: run OAuth PKCE loopback flow!
            try {
                setTransientNotice(prompt, '● Opening browser for OpenRouter OAuth authorization… (Waiting on 127.0.0.1)', 120_000);
                const { apiKey } = await startLoopbackAuth({ timeoutMs: 120_000, openBrowser: true });
                saveOpenRouterKey(apiKey, { setAsActive: true, store });
                const updatedConfig = store.loadConfig();
                if (options.loop) {
                    options.loop.config = updatedConfig;
                    if (typeof options.loop.updateTierLimits === 'function') {
                        options.loop.updateTierLimits();
                    }
                }
                notifyPrompt('openrouter', target.modelId);
                setTransientNotice(prompt, `✓ Connected to OpenRouter successfully! Using OpenRouter Free / ${target.modelId}.`, 5000);
                if (prompt.surface?.stage) {
                    prompt.surface.stage.invalidate();
                }
                if (typeof prompt.scheduleDraw === 'function') {
                    prompt.scheduleDraw();
                }
                return `✓ Connected to OpenRouter successfully! Now using OpenRouter Free / ${target.modelId}.`;
            }
            catch (err) {
                setTransientNotice(prompt, `✕ OpenRouter authorization failed: ${err?.message || err}`, 6000);
                return (`✕ OpenRouter authorization failed: ${err?.message || err}\n\n` +
                    `Solutions:\n` +
                    `1. Check that your browser can open local URLs (http://127.0.0.1).\n` +
                    `2. For headless or SSH environments, create a free API key at:\n` +
                    `   https://openrouter.ai/keys\n` +
                    `   and run: /openrouter connect <your-api-key>`);
            }
        }
        // User pasted an API key
        await showConfiguringAnimation('OpenRouter', prompt);
        saveOpenRouterKey(cleanInput, { setAsActive: true, store });
        const updatedConfig = store.loadConfig();
        if (options.loop) {
            options.loop.config = updatedConfig;
            if (typeof options.loop.updateTierLimits === 'function') {
                options.loop.updateTierLimits();
            }
        }
        notifyPrompt('openrouter', target.modelId);
        return `✓ Saved API key. Now using OpenRouter Free / ${target.modelId}.`;
    }
    // Case 3: BYOK Provider (Cloud or Local API)
    let existingKey = '';
    const providerKeys = (config['providerKeys'] && typeof config['providerKeys'] === 'object') ? config['providerKeys'] : {};
    if (config['provider'] === target.providerId && typeof config['apiKey'] === 'string' && config['apiKey']) {
        existingKey = config['apiKey'];
    }
    else if (providerKeys[target.providerId] || (target.providerId === 'qwen' && providerKeys['dashscope-byok'])) {
        existingKey = providerKeys[target.providerId] || providerKeys['dashscope-byok'] || '';
    }
    else if (target.envVar && process.env[target.envVar]) {
        existingKey = process.env[target.envVar] || '';
    }
    // If provider is Ollama (needs no key) or key is already present
    if (target.providerId === 'ollama' || existingKey) {
        config['provider'] = target.providerId;
        config['model'] = target.modelId;
        if (existingKey) {
            config['apiKey'] = existingKey;
            config['providerKeys'] = providerKeys;
            config['providerKeys'][target.providerId] = existingKey;
        }
        store.saveConfig(config);
        // Proactively refresh live models in the background for this active provider
        if (existingKey || target.providerId === 'ollama') {
            void resolveAvailableModels(target.providerId, { ...config, apiKey: existingKey }, true).catch(() => { });
        }
        if (options.loop) {
            options.loop.config = config;
            if (typeof options.loop.updateTierLimits === 'function') {
                options.loop.updateTierLimits();
            }
        }
        notifyPrompt(target.providerId, target.modelId);
        return `Now using ${target.providerLabel} / ${target.modelId}.`;
    }
    // Key is required: open modal input dialog (InputLayer)
    const enteredKey = await new Promise((resolve) => {
        const layer = new InputLayer({
            title: `Set API Key · ${target.providerLabel}`,
            lines: [
                `Enter your ${target.providerLabel} API key to use ${target.modelId}.`,
                'Stored encrypted in your local vault (~/.causyne/config.json).'
            ],
            mask: true,
            placeholder: 'paste API key (Esc to cancel)',
            onSubmit: resolve,
            onCancel: () => resolve(null)
        });
        prompt.openLayer(layer);
    });
    if (!enteredKey || !enteredKey.trim()) {
        return `Cancelled. An API key is required to use ${target.providerLabel} / ${target.modelId}. Model was not changed.`;
    }
    const cleanKey = enteredKey.trim();
    await showConfiguringAnimation(target.providerLabel, prompt);
    config['provider'] = target.providerId;
    config['model'] = target.modelId;
    config['apiKey'] = cleanKey;
    config['providerKeys'] = providerKeys;
    config['providerKeys'][target.providerId] = cleanKey;
    store.saveConfig(config);
    // Proactively refresh live models in the background with the newly saved key
    void resolveAvailableModels(target.providerId, { ...config, apiKey: cleanKey }, true).catch(() => { });
    if (options.loop) {
        options.loop.config = config;
        if (typeof options.loop.updateTierLimits === 'function') {
            options.loop.updateTierLimits();
        }
    }
    notifyPrompt(target.providerId, target.modelId);
    return `Saved API key. Now using ${target.providerLabel} / ${target.modelId}.`;
}
