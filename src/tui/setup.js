/** Shared setup transaction for the home panel and standalone CLI. */
import { resolveAvailableModels } from '../dynamicCatalogue.js';
import { getPermissionPresetDescriptor, normalizePermissionPreset, presetToAutonomyMode } from '../permissionPresets.js';
import { reconcileConfigVariant } from '../modelVariants.js';
import { safeDisplay } from './text.js';
const string = (value) => typeof value === 'string' ? value : '';
const customProviders = new Set(['openai-compatible', 'dashscope-byok', 'ollama']);
/** Peers and Antigravity authenticate through their own CLI, not a stored key. */
function isLocalAgent(providerId) {
    return providerId === 'acp' || providerId.startsWith('acp/')
        || providerId === 'antigravity' || providerId === 'agy' || providerId === 'pi';
}
const defaults = {
    ollama: 'http://localhost:11434/api/chat',
    'dashscope-byok': 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions'
};
const FREE_KEY_SIGNUP_HINTS = {
    openrouter: 'Free API key (no credit card for :free models): https://openrouter.ai/keys',
    'openrouter-free': 'Free API key (no credit card for :free models): https://openrouter.ai/keys',
    groq: 'Free API key (no credit card required): https://console.groq.com/keys',
    cerebras: 'Free API key (no credit card required): https://cloud.cerebras.ai',
    'gemini-free': 'Free API key (no credit card required): https://aistudio.google.com/apikey',
    mistral: 'Free Experiment / Codestral API key (no credit card): https://console.mistral.ai'
};
export function freeKeySignupHint(providerId) {
    return Object.hasOwn(FREE_KEY_SIGNUP_HINTS, providerId) ? FREE_KEY_SIGNUP_HINTS[providerId] : '';
}
export function validateEndpoint(value) {
    if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f-\x9f\s]/.test(value)) {
        return 'Use a single-line endpoint URL without whitespace or control characters.';
    }
    try {
        const url = new URL(value);
        if (url.username || url.password || url.search || url.hash)
            return 'Use an endpoint without credentials, query parameters, or a fragment.';
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
            return 'Use HTTPS, or HTTP on localhost for a local model.';
        return null;
    }
    catch {
        return 'Enter a complete endpoint URL.';
    }
}
export async function runSetup(ui, providers, store, workspace = process.cwd()) {
    const original = store.loadConfig();
    let draft = { ...original };
    async function text(title, lines, value = '', mask = false, validate = () => null) {
        let error = null;
        for (;;) {
            const answer = await ui.text({ title, lines: error ? [...lines, error] : lines, value,
                placeholder: mask ? 'paste key' : '', mask });
            if (answer === null)
                return null;
            const cleaned = answer.trim();
            error = /[\x00-\x1f\x7f]/.test(cleaned) ? 'Use a single line without control characters.' : validate(cleaned);
            if (!error)
                return cleaned;
            value = mask ? '' : cleaned;
        }
    }
    for (;;) {
        const selected = await ui.select({ title: 'Setup 1/5 · provider', items: providers.map(p => ({ id: p.id, label: p.label, description: p.hint })) });
        if (!selected)
            return null;
        const provider = providers.find(p => p.id === selected.id);
        if (!provider)
            return null;
        const sameProvider = draft.provider === provider.id;
        let baseUrl = '';
        if (customProviders.has(provider.id)) {
            const answer = await text('Setup 2/5 · endpoint', ['Full chat endpoint URL, including /v1/chat/completions or /api/chat.',
                'Credentials are sent to this endpoint when you use the model.'], (sameProvider ? string(draft.baseUrl) : '') || defaults[provider.id] || '', false, validateEndpoint);
            // No network request is made by setup.
            if (answer === null)
                return null;
            baseUrl = answer;
        }
        const suggestedModel = (sameProvider ? string(draft.model) : '') || provider.model;
        let model;
        if (isLocalAgent(provider.id)) {
            // The peer already knows which models its account can reach. Listing them
            // is the whole point of treating it as a provider; a blank text box would
            // make the user guess ids the CLI could have told us for free.
            let known = [];
            try {
                known = (await resolveAvailableModels(provider.id, {}, false)).models;
            }
            catch {
                known = [];
            }
            if (known.length === 0) {
                model = await text('Setup 2/5 · model', ['Enter a model ID published by the installed CLI.',
                    'Leave the default to let the peer choose its own model.'], suggestedModel, false, value => value ? null : 'A model ID is required.');
            }
            else {
                const picked = await ui.select({ title: 'Setup 2/5 · model', items: [
                        ...known.map((id) => ({ id, label: id, description: provider.label })),
                        { id: '__custom__', label: 'Other model ID…', description: 'enter one manually' }
                    ] });
                if (!picked)
                    return null;
                model = picked.id === '__custom__'
                    ? await text('Setup 2/5 · model', ['Enter the model ID published by the installed CLI.'], suggestedModel, false, value => value ? null : 'A model ID is required.')
                    : picked.id;
            }
        }
        else {
            model = await text('Setup 2/5 · model', ['Enter the model ID supported by your provider.'], suggestedModel, false, value => value ? null : 'A model ID is required.');
        }
        if (model === null)
            return null;
        const unchangedEndpoint = sameProvider && (string(draft.baseUrl) || defaults[provider.id] || '') === baseUrl;
        // Fixed endpoints have no editable URL. A changed endpoint never inherits a key.
        const keepKey = sameProvider && (!customProviders.has(provider.id) || unchangedEndpoint);
        let apiKey = '';
        if (provider.id !== 'ollama' && !isLocalAgent(provider.id)) {
            const oldKey = keepKey ? string(draft.apiKey) : '';
            const freeHint = freeKeySignupHint(provider.id);
            const answer = await text('Setup 3/5 · credentials', ['Stored encrypted locally; used to authenticate with your selected provider.',
                oldKey ? 'Blank keeps the key for this same provider and endpoint.' : 'Enter a key for this provider.',
                freeHint || (provider.id === 'openai-compatible' ? 'Blank is allowed for an endpoint that needs no authentication.' : '')], '', true, value => value || oldKey || provider.id === 'openai-compatible' ? null : 'An API key is required.');
            if (answer === null)
                return null;
            apiKey = answer || oldKey;
        }
        const selectedPerm = await ui.select({ title: 'Setup 4/5 · permissions', items: [
                { id: 'workspace-write', label: 'Workspace Write (Recommended)', description: 'Read and edit files within the workspace; confirm risky or external actions.' },
                { id: 'read-only', label: 'Read Only', description: 'Inspect files and search code without modifying workspace files.' },
                { id: 'danger-full-access', label: 'Full access', description: 'Direct workspace edits and commands; destructive and credential safeguards remain.' }
            ] });
        const chosenPreset = normalizePermissionPreset(selectedPerm?.id);
        if (!chosenPreset)
            return null;
        const chosenDesc = getPermissionPresetDescriptor(chosenPreset);
        const chosenAutonomy = presetToAutonomyMode(chosenPreset);
        draft = { ...draft, provider: provider.id, model, apiKey, permissionPreset: chosenPreset, autonomyMode: chosenAutonomy };
        if (baseUrl)
            draft.baseUrl = baseUrl;
        else
            delete draft.baseUrl;
        const cleanWorkspace = safeDisplay(workspace).replace(/\s+/g, ' ').trim();
        const cleanLabel = safeDisplay(provider.label).replace(/\s+/g, ' ').trim();
        const cleanModel = safeDisplay(model).replace(/\s+/g, ' ').trim();
        const review = await ui.select({ title: 'Setup 5/5 · review', items: [
                { id: 'save', label: 'Save configuration', description: `${cleanLabel} · ${cleanModel} · ${chosenDesc.label}` },
                { id: 'edit', label: 'Edit choices', description: baseUrl || 'Provider default endpoint' },
                { id: 'cancel', label: 'Cancel without saving', description: `Workspace: ${cleanWorkspace}` }
            ] });
        if (!review || review.id === 'cancel')
            return null;
        if (review.id === 'edit')
            continue;
        if (review.id !== 'save')
            return null;
        // Preserve unrelated settings changed while the dialog was open, while clearing
        // stale reasoning variants when switching provider or model.
        const existingCfg = store.loadConfig();
        const providerOrModelChanged = existingCfg.provider !== draft.provider || existingCfg.model !== model;
        const next = { ...existingCfg, provider: draft.provider, model, apiKey, permissionPreset: chosenPreset, autonomyMode: chosenAutonomy };
        if (providerOrModelChanged) {
            delete next.reasoningEffort;
            delete next.reasoningBudgetTokens;
        }
        reconcileConfigVariant(next);
        const saved = next;
        if (baseUrl)
            saved.baseUrl = baseUrl;
        else
            delete saved.baseUrl;
        if (provider.id !== 'ollama' && !isLocalAgent(provider.id)) {
            const existingProviderKeys = saved.providerKeys && typeof saved.providerKeys === 'object' && !Array.isArray(saved.providerKeys)
                ? { ...saved.providerKeys }
                : null;
            if (apiKey) {
                saved.providerKeys = { ...(existingProviderKeys || {}), [provider.id]: apiKey };
            }
            else if (existingProviderKeys && provider.id in existingProviderKeys) {
                delete existingProviderKeys[provider.id];
                saved.providerKeys = existingProviderKeys;
            }
        }
        store.saveConfig(saved);
        if (apiKey || provider.id === 'ollama' || isLocalAgent(provider.id)) {
            void resolveAvailableModels(provider.id, saved, true).catch(() => { });
        }
        return { provider: provider.id, model };
    }
}
