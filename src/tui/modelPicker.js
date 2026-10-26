// Sovereign Interactive Model Picker — modal dialog for ACP & BYOK models.
//
// Pure Node over ./dialogs.js, ../dynamicCatalogue.js, and ../config.js.
// No shell, zero malware, source-available under BUSL-1.1.
// @ts-expect-error untyped local TUI dialogs
import { SelectLayer, InputLayer } from './dialogs.js';
import { loadConfig, saveConfig } from '../config.js';
import { getAvailableProvidersOverview } from '../dynamicCatalogue.js';
async function showConfiguringAnimation(providerLabel) {
    if (!process.stdout.isTTY)
        return;
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    const text = `Configuring ${providerLabel} in secure local vault…`;
    for (let i = 0; i < 5; i++) {
        const f = frames[i % frames.length];
        process.stdout.write(`\r  \x1b[36m${f}\x1b[0m ${text}`);
        await new Promise(r => setTimeout(r, 60));
    }
    process.stdout.write(`\r\x1b[K  \x1b[32m✓\x1b[0m ${providerLabel} credentials saved.\n`);
}
/**
 * Build items for SelectLayer categorized by ACP peers and BYOK providers.
 */
export function buildModelPickerItems(config, overview) {
    const items = [];
    const activeProvider = config.provider || '';
    const activeModel = config.model || '';
    // 1. ACP Peer Agents & Sovereign Local Engines
    for (const peer of overview.acp) {
        const isCurrentProvider = activeProvider === peer.providerKey;
        const catTitle = peer.installed
            ? `ACP · ${peer.label} (ready)`
            : `ACP · ${peer.label} (not installed)`;
        if (peer.installed && Array.isArray(peer.models) && peer.models.length > 0) {
            for (const m of peer.models) {
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
    // 2. BYOK Providers (Cloud & Local APIs)
    for (const p of overview.byok) {
        const isCurrentProvider = activeProvider === p.id || (p.id === 'qwen' && activeProvider === 'dashscope-byok');
        const catTitle = p.id === 'ollama'
            ? `BYOK · ${p.label}`
            : `BYOK · ${p.label} ${p.isConfigured ? '(configured)' : '(needs key)'}`;
        const models = Array.isArray(p.models) && p.models.length > 0 ? p.models : [p.defaultModel];
        for (const m of models) {
            const isCurrent = isCurrentProvider && activeModel === m;
            const desc = isCurrent ? '● active' : (p.id === 'ollama' ? 'local' : (p.isConfigured ? 'configured' : 'needs API key'));
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
    return items;
}
/**
 * Run interactive model picker in the provided TUI prompt.
 *
 * Automatically handles:
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
    const items = buildModelPickerItems(config, overview);
    const picked = await new Promise((resolve) => {
        const layer = new SelectLayer({
            title: 'Select Model',
            placeholder: 'type to filter (e.g. gemini, sonnet, opencode)…',
            emptyText: 'No models matched your search',
            items,
            width: 76,
            height: 20,
            onPick: resolve
        });
        prompt.openLayer(layer);
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
    if (!picked || !picked.value) {
        return 'Cancelled. Model was not changed.';
    }
    const target = picked.value;
    // Case 1: ACP Peer Agent or Antigravity
    if (target.type === 'acp') {
        if (!target.installed) {
            return (`⚠️ Notice: "${target.providerLabel}" is not installed on this machine.\n` +
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
    // Case 2: BYOK Provider (Cloud or Local API)
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
    await showConfiguringAnimation(target.providerLabel);
    config['provider'] = target.providerId;
    config['model'] = target.modelId;
    config['apiKey'] = cleanKey;
    config['providerKeys'] = providerKeys;
    config['providerKeys'][target.providerId] = cleanKey;
    store.saveConfig(config);
    if (options.loop) {
        options.loop.config = config;
        if (typeof options.loop.updateTierLimits === 'function') {
            options.loop.updateTierLimits();
        }
    }
    notifyPrompt(target.providerId, target.modelId);
    return `Saved API key. Now using ${target.providerLabel} / ${target.modelId}.`;
}
