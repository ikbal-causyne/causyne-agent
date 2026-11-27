import { loadConfig, saveConfig } from '../config.js';
import { PERMISSION_PRESET_CATALOG, getDefaultPermissionPreset, getPermissionPresetDescriptor, normalizePermissionPreset, setDefaultPermissionPreset } from '../permissionPresets.js';
import { getAvailableProvidersOverview, getLiveAntigravityModels, getModelVariantsForPeer } from '../dynamicCatalogue.js';
import { resolveModelVariants } from '../modelVariants.js';
import { isAcpProvider } from '../providers/acp.js';
import { writeClipboardSync } from './clipboardSync.js';
import { SelectLayer } from './dialogs.js';
import { looksSensitive } from './history.js';
export function openModeControl(prompt, loop) {
    const current = getDefaultPermissionPreset();
    prompt.openLayer(new SelectLayer({
        title: 'Permission preset',
        items: PERMISSION_PRESET_CATALOG.map((preset) => ({
            id: preset.id,
            label: `${preset.label}${preset.id === current ? '  (active)' : ''}`,
            description: preset.description,
            value: preset.id
        })),
        onPick: (item) => {
            const chosen = normalizePermissionPreset(item?.value);
            if (!chosen)
                return;
            const desc = getPermissionPresetDescriptor(chosen);
            setDefaultPermissionPreset(chosen);
            if (typeof loop.setPermissionPreset === 'function') {
                loop.setPermissionPreset(chosen);
            }
            else {
                loop.setAutonomyMode(desc.autonomyMode);
            }
            prompt.renderer?.status?.setSession?.({ permissionPreset: chosen, autonomyMode: desc.autonomyMode });
            prompt.surface?.setSessionInfo?.({ permissionPreset: chosen, autonomyMode: desc.autonomyMode });
            prompt.notice = `${desc.label} active`;
            prompt.scheduleDraw();
        }
    }));
}
function splitModelVariant(model) {
    if (!model.endsWith(')'))
        return null;
    const openIndex = model.lastIndexOf(' (');
    if (openIndex < 0)
        return null;
    const variant = model.slice(openIndex + 2, -1);
    if (!variant || variant.includes('(') || variant.includes(')'))
        return null;
    return { base: model.slice(0, openIndex), variant };
}
/** Only offer sibling variants the selected provider actually advertises. */
export function availableModelVariants(config) {
    if (!config || typeof config !== 'object')
        return [];
    const current = typeof config.model === 'string' ? config.model : String(config.model ?? '');
    const parsed = splitModelVariant(current);
    if (!parsed)
        return [];
    const overview = getAvailableProvidersOverview(config);
    const provider = typeof config.provider === 'string' ? config.provider : String(config.provider ?? '');
    const advertised = overview.acp.find(peer => peer.providerKey === provider)?.models
        ?? overview.byok.find(item => item.id === provider)?.models
        ?? [];
    return advertised.filter(model => splitModelVariant(model)?.base === parsed.base);
}
export function cycleModeControl(prompt, loop) {
    const order = ['read-only', 'workspace-write', 'danger-full-access'];
    const current = normalizePermissionPreset(loop?.config?.permissionPreset)
        ?? normalizePermissionPreset(loop?.config?.autonomyMode)
        ?? getDefaultPermissionPreset();
    const idx = order.indexOf(current);
    const next = order[(idx + 1) % order.length];
    const desc = getPermissionPresetDescriptor(next);
    setDefaultPermissionPreset(next);
    if (typeof loop.setPermissionPreset === 'function') {
        loop.setPermissionPreset(next);
    }
    else {
        loop.setAutonomyMode(desc.autonomyMode);
    }
    prompt.renderer?.status?.setSession?.({ permissionPreset: next, autonomyMode: desc.autonomyMode });
    prompt.surface?.setSessionInfo?.({ permissionPreset: next, autonomyMode: desc.autonomyMode });
    prompt.notice = `${desc.label} · Shift+Tab cycle · Ctrl+G menu`;
    prompt.scheduleDraw();
}
function resolveVariantSpecForControl(config, loop) {
    const provider = typeof config.provider === 'string' ? config.provider.trim() : '';
    const model = typeof config.model === 'string' ? config.model.trim() : '';
    const liveAcpVariant = typeof loop?.llm?.getLiveVariantOption === 'function'
        ? loop.llm.getLiveVariantOption()
        : null;
    let ollamaSupportsThinking = null;
    if (provider.toLowerCase() === 'ollama' && loop?.llm) {
        const metaCache = loop.llm._modelMetaCache;
        const cachedMeta = metaCache?.get(model);
        if (cachedMeta && typeof cachedMeta.supportsThinking === 'boolean') {
            ollamaSupportsThinking = cachedMeta.supportsThinking;
        }
    }
    const providerLower = provider.toLowerCase();
    const liveAgyModels = (providerLower.includes('antigravity') || providerLower === 'agy')
        ? getLiveAntigravityModels(config)
        : undefined;
    const peerModelVariants = isAcpProvider(provider)
        ? getModelVariantsForPeer(provider, model, config)
        : undefined;
    return resolveModelVariants({
        provider,
        model,
        currentVariant: typeof config.reasoningEffort === 'string' ? config.reasoningEffort : null,
        liveAcpVariant,
        peerModelVariants,
        ollamaSupportsThinking,
        availableAgyModels: liveAgyModels && liveAgyModels.length > 0 ? liveAgyModels : undefined
    });
}
function applyVariantSilently(rawChoice, spec, config, prompt, loop) {
    const isAuto = rawChoice.toLowerCase() === 'auto';
    if (isAuto) {
        delete config.reasoningEffort;
        delete config.reasoningBudgetTokens;
        saveConfig(config);
        const liveAcp = typeof loop?.llm?.getLiveVariantOption === 'function'
            ? loop.llm.getLiveVariantOption()
            : null;
        if (liveAcp
            && Array.isArray(liveAcp.options)
            && liveAcp.options.some((opt) => String(opt?.value || '').toLowerCase() === 'default')
            && typeof loop?.llm?.applyVariant === 'function') {
            void Promise.resolve(loop.llm.applyVariant('default', liveAcp.configOptionId || spec.acpConfigId)).catch(() => { });
        }
        if (loop) {
            loop.config = loadConfig();
            if (typeof loop.updateTierLimits === 'function')
                loop.updateTierLimits();
        }
        if (typeof prompt.updateModel === 'function') {
            prompt.updateModel(config.provider || spec.provider, config.model || spec.model, '');
        }
        else {
            prompt.renderer?.status?.setSession?.({ variant: '' });
            prompt.surface?.setSessionInfo?.({ variant: '' });
        }
        return;
    }
    const matched = spec.options.find((o) => o.id.toLowerCase() === rawChoice.toLowerCase());
    if (!matched)
        return;
    const modelChanged = Boolean(matched.targetModelId && matched.targetModelId !== config.model);
    if (matched.targetModelId) {
        config.model = matched.targetModelId;
    }
    if (spec.source === 'agy_models') {
        delete config.reasoningEffort;
        delete config.reasoningBudgetTokens;
    }
    else {
        config.reasoningEffort = matched.id;
    }
    saveConfig(config);
    const displayedVariant = spec.source === 'agy_models' ? '' : matched.id;
    if (typeof loop?.llm?.applyVariant === 'function' && !modelChanged) {
        void Promise.resolve(loop.llm.applyVariant(matched.id, matched.acpConfigId)).then(() => {
            if (loop)
                loop.config = loadConfig();
        }).catch(() => { });
    }
    else if (loop) {
        loop.config = loadConfig();
        if (typeof loop.updateTierLimits === 'function')
            loop.updateTierLimits();
    }
    if (typeof prompt.updateModel === 'function') {
        prompt.updateModel(config.provider || spec.provider, config.model || spec.model, displayedVariant);
    }
    else {
        prompt.renderer?.status?.setSession?.({
            provider: config.provider || spec.provider,
            model: config.model || spec.model,
            variant: displayedVariant
        });
        prompt.surface?.setSessionInfo?.({
            provider: config.provider || spec.provider,
            model: config.model || spec.model,
            variant: displayedVariant
        });
    }
}
export function cycleVariantControl(prompt, loop) {
    const config = loadConfig();
    const spec = resolveVariantSpecForControl(config, loop);
    if (!spec.supported || spec.options.length === 0) {
        prompt.notice = spec.note || 'Active model does not expose tunable reasoning variants';
        prompt.scheduleDraw();
        return;
    }
    const cycleValues = spec.source === 'agy_models'
        ? spec.options.map((o) => o.id)
        : [...spec.options.map((o) => o.id), 'auto'];
    const currentId = (typeof config.reasoningEffort === 'string' && config.reasoningEffort.trim())
        ? config.reasoningEffort.trim().toLowerCase()
        : (spec.source === 'agy_models' && spec.currentVariant ? spec.currentVariant.toLowerCase() : 'auto');
    const currentIdx = cycleValues.findIndex((v) => v.toLowerCase() === currentId);
    const nextIdx = (currentIdx + 1) % cycleValues.length;
    const nextVal = cycleValues[nextIdx];
    applyVariantSilently(nextVal, spec, config, prompt, loop);
    const positionLabel = nextVal === 'auto'
        ? 'auto (default)'
        : `${nextVal} (${nextIdx + 1}/${spec.options.length})`;
    prompt.notice = `Variant: ${positionLabel} · Ctrl+T cycle · Alt+T list`;
    prompt.scheduleDraw();
}
export function openVariantControl(prompt, loop) {
    const config = loadConfig();
    const spec = resolveVariantSpecForControl(config, loop);
    if (!spec.supported || spec.options.length === 0) {
        prompt.notice = spec.note || 'Active model does not expose tunable reasoning variants';
        prompt.scheduleDraw();
        return;
    }
    const sourceLabel = spec.source === 'acp_live'
        ? 'ACP Live'
        : (spec.source === 'peer_catalogue'
            ? 'Peer Catalogue'
            : (spec.source === 'agy_models' ? 'Antigravity' : (spec.source === 'ollama_live' ? 'Ollama Local' : 'Detected')));
    const items = [
        ...spec.options.map((opt) => {
            const isActive = Boolean(spec.currentVariant && opt.id.toLowerCase() === spec.currentVariant.toLowerCase());
            return {
                id: opt.id,
                label: `${isActive ? '● ' : '  '}${opt.label} (${opt.id})`,
                description: opt.description,
                category: `${spec.model || spec.provider} — ${sourceLabel}`,
                value: opt.id
            };
        }),
        {
            id: 'auto',
            label: `${!spec.currentVariant ? '● ' : '  '}Auto (model default)`,
            description: spec.defaultVariant ? `Use model default (${spec.defaultVariant})` : 'Reset explicit variant override',
            category: 'Reset',
            value: 'auto'
        }
    ];
    prompt.openLayer(new SelectLayer({
        title: `Variant · ${spec.model || spec.provider || 'Model'}`,
        items,
        showFilter: items.length > 6,
        onPick: (item) => {
            if (!item?.value)
                return;
            applyVariantSilently(item.value, spec, loadConfig(), prompt, loop);
            prompt.notice = item.value === 'auto' ? 'Variant reset to auto' : `Variant set to ${item.value}`;
            prompt.scheduleDraw();
        }
    }));
}
export function resetTurnInterruptState(prompt, busy) {
    prompt.interruptedTurn = false;
    if (!busy) {
        prompt.statusMessage = '';
        prompt.notice = '';
    }
}
export function shouldAcceptStatusUpdate(prompt) {
    return !(prompt.busy && prompt.interruptedTurn);
}
export function triggerTurnInterrupt(prompt, formatInterruptedRow, options = {}) {
    if (Array.isArray(prompt.queue)) {
        prompt.queue.length = 0;
    }
    prompt.statusMessage = 'interrupting…';
    if (!prompt.interruptedTurn) {
        prompt.interruptedTurn = true;
        prompt.erase();
        prompt.commit('notice', () => formatInterruptedRow());
        prompt.notice = options.viaCtrlC ? 'interrupting… press Ctrl+C again to exit' : '';
    }
    else {
        prompt.notice = 'interrupting… press Ctrl+C again to exit';
    }
    prompt.onInterrupt();
    prompt.scheduleDraw();
}
export function handlePromptCtrlC(prompt, formatInterruptedRow, windowMs = 2000, now = Date.now()) {
    if (!prompt.editor.isEmpty) {
        const text = prompt.editor.getText();
        const isSecret = Boolean(text && looksSensitive(text));
        if (text && !isSecret) {
            writeClipboardSync(text);
            if ('killRing' in prompt.editor) {
                prompt.editor.killRing = text;
            }
        }
        prompt.editor.clear();
        prompt.completion = null;
        prompt.notice = !text
            ? ''
            : (isSecret ? 'cleared (secret not copied to clipboard)' : 'cleared and copied to clipboard');
        return;
    }
    if (prompt.busy) {
        if (prompt.interruptedTurn && now - prompt.lastCtrlC < windowMs) {
            prompt.onInterrupt();
            prompt.onExit();
            return;
        }
        prompt.lastCtrlC = now;
        triggerTurnInterrupt(prompt, formatInterruptedRow, { viaCtrlC: true });
        return;
    }
    if (now - prompt.lastCtrlC < windowMs) {
        prompt.onExit();
        return;
    }
    prompt.lastCtrlC = now;
    prompt.notice = 'press Ctrl+C again to exit';
}
export function handlePromptEscape(prompt, formatInterruptedRow) {
    if (prompt.surface?.hoveredTurnIndex !== null && prompt.surface?.hoveredTurnIndex !== undefined) {
        prompt.surface.hoveredTurnIndex = null;
        prompt.surface.hoveredTurnAnchorY = null;
        prompt.scheduleDraw();
        return;
    }
    if (prompt.usageCard || prompt.usageCardLoading) {
        if (typeof prompt.closeUsageCard === 'function')
            prompt.closeUsageCard();
        else {
            prompt.usageCard = null;
            prompt.scheduleDraw();
        }
        return;
    }
    if (prompt.statusCard !== null && prompt.statusCard !== undefined) {
        if (typeof prompt.closeStatusCard === 'function')
            prompt.closeStatusCard();
        else {
            prompt.statusCard = null;
            prompt.scheduleDraw();
        }
        return;
    }
    if (prompt.completion) {
        prompt.completion = null;
        if (prompt.editor.getText().startsWith('/')) {
            prompt.editor.clear();
        }
        prompt.scheduleDraw();
        return;
    }
    if (prompt.busy) {
        triggerTurnInterrupt(prompt, formatInterruptedRow, { viaCtrlC: false });
        return;
    }
    prompt.editor.clear();
}
