import { loadConfig, saveConfig } from '../config.js';
import { getAvailableProvidersOverview } from '../dynamicCatalogue.js';
// @ts-expect-error dialogs.js is awaiting TypeScript migration.
import { SelectLayer } from './dialogs.js';
export function openModeControl(prompt, loop) {
    const config = loadConfig();
    const current = String(config.autonomyMode || 'B').toUpperCase();
    prompt.openLayer(new SelectLayer({
        title: 'Autonomy mode',
        items: [
            { id: 'A', label: 'A · Ask', description: 'Review actions before execution', value: 'A' },
            { id: 'B', label: 'B · Balanced', description: 'Work independently within permission boundaries', value: 'B' },
            { id: 'C', label: 'C · Autonomous', description: 'Continue within the selected workspace and policy', value: 'C' }
        ].map(item => ({ ...item, label: `${item.label}${item.value === current ? '  (active)' : ''}` })),
        onPick: (item) => {
            if (!item?.value)
                return;
            config.autonomyMode = item.value;
            saveConfig(config);
            loop.setAutonomyMode(item.value);
            prompt.notice = `Mode ${item.value} active`;
            prompt.scheduleDraw();
        }
    }));
}
/** Only offer sibling variants the selected provider actually advertises. */
export function availableModelVariants(config) {
    const current = String(config.model || '');
    const match = current.match(/^(.*)\s\(([^()]+)\)$/);
    if (!match)
        return [];
    const overview = getAvailableProvidersOverview(config);
    const provider = String(config.provider || '');
    const advertised = overview.acp.find(peer => peer.providerKey === provider)?.models
        ?? overview.byok.find(item => item.id === provider)?.models
        ?? [];
    return advertised.filter(model => {
        const sibling = model.match(/^(.*)\s\(([^()]+)\)$/);
        return sibling?.[1] === match[1];
    });
}
export function openVariantControl(prompt) {
    const config = loadConfig();
    const variants = availableModelVariants(config);
    if (variants.length < 2) {
        prompt.notice = 'This provider has no advertised model variants';
        prompt.scheduleDraw();
        return;
    }
    prompt.openLayer(new SelectLayer({
        title: 'Model variant',
        items: variants.map(model => ({
            id: model,
            label: `${model}${model === config.model ? '  (active)' : ''}`,
            description: String(config.provider || ''),
            value: model
        })),
        onPick: (item) => {
            if (!item?.value || item.value === config.model)
                return;
            prompt.deliver(`/model ${String(config.provider)}/${item.value}`);
            prompt.notice = 'Model variant change queued';
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
        prompt.editor.clear();
        prompt.completion = null;
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
