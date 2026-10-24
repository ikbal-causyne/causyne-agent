/** Shared setup transaction for the home panel and standalone CLI. */
import { resolveAvailableModels } from '../dynamicCatalogue.js';
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
export function validateEndpoint(value) {
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
            const known = (await resolveAvailableModels(provider.id, {}, false)).models;
            if (known.length === 0) {
                model = await text('Setup 3/5 · model', ['Enter a model ID published by the installed CLI.',
                    'Leave the default to let the peer choose its own model.'], suggestedModel, false, value => value ? null : 'A model ID is required.');
            }
            else {
                const picked = await ui.select({ title: 'Setup 3/5 · model', items: [
                        ...known.map((id) => ({ id, label: id, description: provider.label })),
                        { id: '__custom__', label: 'Other model ID…', description: 'enter one manually' }
                    ] });
                if (!picked)
                    return null;
                model = picked.id === '__custom__'
                    ? await text('Setup 3/5 · model', ['Enter the model ID published by the installed CLI.'], suggestedModel, false, value => value ? null : 'A model ID is required.')
                    : picked.id;
            }
        }
        else {
            model = await text('Setup 3/5 · model', ['Enter the model ID supported by your provider.'], suggestedModel, false, value => value ? null : 'A model ID is required.');
        }
        if (model === null)
            return null;
        const unchangedEndpoint = sameProvider && (string(draft.baseUrl) || defaults[provider.id] || '') === baseUrl;
        // Fixed endpoints have no editable URL. A changed endpoint never inherits a key.
        const keepKey = sameProvider && (!customProviders.has(provider.id) || unchangedEndpoint);
        let apiKey = '';
        if (provider.id !== 'ollama' && !isLocalAgent(provider.id)) {
            const oldKey = keepKey ? string(draft.apiKey) : '';
            const answer = await text('Setup 3/5 · credentials', ['Stored encrypted locally; used to authenticate with your selected provider.',
                oldKey ? 'Blank keeps the key for this same provider and endpoint.' : 'Enter a key for this provider.',
                provider.id === 'openai-compatible' ? 'Blank is allowed for an endpoint that needs no authentication.' : ''], '', true, value => value || oldKey || provider.id === 'openai-compatible' ? null : 'An API key is required.');
            if (answer === null)
                return null;
            apiKey = answer || oldKey;
        }
        const mode = await ui.select({ title: 'Setup 4/5 · autonomy', items: [
                { id: 'B', label: 'B · Supervised (Standard)', description: 'Recommended. Approval for dangerous actions; routine work continues.' },
                { id: 'A', label: 'A · Ask first (Strict)', description: 'Explicit confirmation before every tool call.' },
                { id: 'C', label: 'C · Autonomous (High Velocity)', description: 'Fewer interruptions; mandatory safety and decision gates remain.' }
            ] });
        if (!mode || !['A', 'B', 'C'].includes(mode.id))
            return null;
        draft = { ...draft, provider: provider.id, model, apiKey, autonomyMode: mode.id };
        if (baseUrl)
            draft.baseUrl = baseUrl;
        else
            delete draft.baseUrl;
        const review = await ui.select({ title: 'Setup 5/5 · review', items: [
                { id: 'save', label: 'Save configuration', description: `${provider.label} · ${model} · Mode ${mode.id}` },
                { id: 'edit', label: 'Edit choices', description: baseUrl || 'Provider default endpoint' },
                { id: 'cancel', label: 'Cancel without saving', description: `Workspace: ${workspace}` }
            ] });
        if (!review || review.id === 'cancel')
            return null;
        if (review.id === 'edit')
            continue;
        if (review.id !== 'save')
            return null;
        // Preserve unrelated settings changed while the dialog was open.
        const next = { ...store.loadConfig(), provider: draft.provider, model, apiKey, autonomyMode: mode.id };
        const saved = next;
        if (baseUrl)
            saved.baseUrl = baseUrl;
        else
            delete saved.baseUrl;
        store.saveConfig(saved);
        return { provider: provider.id, model };
    }
}
