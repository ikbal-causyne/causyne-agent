import { announceStatus, dom } from './dom.js';
import { PERMISSION_PRESET_KEY, apiUrl, authHeaders, state } from './state.js';
import { closeAllPopovers, positionPopover } from './studioShell.js';
const SVG_NS = 'http://www.w3.org/2000/svg';
const BUILTIN_PRESETS = [
    {
        id: 'read-only',
        label: 'Read Only',
        description: 'Inspect files and search code without modifying workspace files.',
        autonomyMode: 'A',
        readOnly: true,
        requiresRiskConfirmation: false
    },
    {
        id: 'workspace-write',
        label: 'Workspace Write',
        description: 'Read and modify files within this workspace with approval gates for risky actions.',
        autonomyMode: 'B',
        readOnly: false,
        requiresRiskConfirmation: false
    },
    {
        id: 'danger-full-access',
        label: 'Full access',
        description: 'Reduces confirmation steps and performs workspace edits and commands directly.',
        autonomyMode: 'C',
        readOnly: false,
        requiresRiskConfirmation: true
    }
];
let catalog = BUILTIN_PRESETS;
let pendingConfirm = null;
let permLocked = false;
export function normalizeClientPreset(raw) {
    if (typeof raw !== 'string')
        return 'workspace-write';
    const v = raw.trim().toLowerCase();
    if (v === 'read-only' || v === 'a')
        return 'read-only';
    if (v === 'danger-full-access' || v === 'full-access' || v === 'c')
        return 'danger-full-access';
    return 'workspace-write';
}
export function presetToLegacyMode(preset) {
    if (preset === 'read-only')
        return 'A';
    if (preset === 'danger-full-access')
        return 'C';
    return 'B';
}
function getPresetMeta(preset) {
    return catalog.find((item) => item.id === preset) ?? BUILTIN_PRESETS[1];
}
function createSvgPath(d) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    return path;
}
function createShieldSvg(preset, className) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.75');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', className);
    if (preset === 'read-only') {
        svg.appendChild(createSvgPath('M12 2.5L4.5 5.5V11.2C4.5 16.2 7.7 20.1 12 21.5C16.3 20.1 19.5 16.2 19.5 11.2V5.5L12 2.5Z'));
        svg.appendChild(createSvgPath('M9 12.2L11.1 14.3L15.3 9.8'));
    }
    else if (preset === 'danger-full-access') {
        svg.appendChild(createSvgPath('M12 2.5L4.5 5.5V11.2C4.5 16.2 7.7 20.1 12 21.5C16.3 20.1 19.5 16.2 19.5 11.2V5.5L12 2.5Z'));
        svg.appendChild(createSvgPath('M12 8.2V12.8'));
        svg.appendChild(createSvgPath('M12 16.2H12.01'));
    }
    else {
        svg.appendChild(createSvgPath('M12 2.5L4.5 5.5V11.2C4.5 15.6 7.1 19.3 11 21.1'));
        svg.appendChild(createSvgPath('M19.5 10.6V5.5L12 2.5'));
        svg.appendChild(createSvgPath('M8.5 9.4H14.5'));
        svg.appendChild(createSvgPath('M8.5 12.6H12.2'));
        svg.appendChild(createSvgPath('M14.3 18.8L18.9 14.2L20.4 15.7L15.8 20.3L13.8 20.8L14.3 18.8Z'));
    }
    return svg;
}
function createCheckSvg() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'perm-option-check');
    svg.appendChild(createSvgPath('M5 12.5L9.5 17L19 7.5'));
    return svg;
}
export function applyPermissionPresetUi(preset) {
    const normalized = normalizeClientPreset(preset);
    state.permissionPreset = normalized;
    const meta = getPresetMeta(normalized);
    dom.permTriggerIcon.textContent = '';
    dom.permTriggerIcon.appendChild(createShieldSvg(normalized, 'perm-shield-svg'));
    dom.permTriggerLabel.textContent = meta.label;
    dom.permTriggerBtn.setAttribute('aria-label', `Permission preset: ${meta.label}`);
    dom.permTriggerBtn.setAttribute('title', `${meta.label} — ${meta.description}`);
    dom.permTriggerBtn.dataset.preset = normalized;
    if (dom.settingsPermSelect) {
        dom.settingsPermSelect.value = state.defaultPermissionPreset;
    }
    try {
        window.localStorage.setItem(PERMISSION_PRESET_KEY, normalized);
    }
    catch { /* ignore */ }
}
export function syncPermissionPresetLock(locked) {
    permLocked = Boolean(locked);
    dom.permTriggerBtn.disabled = permLocked;
    dom.permTriggerBtn.classList.toggle('is-locked', permLocked);
    if (permLocked) {
        dom.permPopover.classList.remove('open');
        dom.permTriggerBtn.classList.remove('open');
        dom.permTriggerBtn.setAttribute('aria-expanded', 'false');
    }
}
export function closePermissionConfirmModal() {
    const hadPending = pendingConfirm !== null;
    pendingConfirm = null;
    dom.permConfirmModal.classList.remove('open');
    dom.permConfirmCheck.checked = false;
    dom.permConfirmOk.disabled = true;
    if (hadPending && dom.settingsPermSelect) {
        dom.settingsPermSelect.value = state.defaultPermissionPreset;
    }
}
function openPermissionConfirmModal(preset, scope) {
    pendingConfirm = { preset, scope };
    const meta = getPresetMeta(preset);
    dom.permConfirmTitle.textContent = `Enable ${meta.label}?`;
    dom.permConfirmDesc.textContent = scope === 'default'
        ? 'Setting Full access as the default reduces confirmation steps for all new sessions, allowing Causyne to edit workspace files and execute commands directly. Destructive command and credential safeguards remain enforced.'
        : 'Full access reduces confirmation steps and allows Causyne to edit workspace files and execute commands directly. Destructive command and credential safeguards remain enforced.';
    dom.permConfirmCheck.checked = false;
    dom.permConfirmOk.disabled = true;
    dom.permConfirmOk.textContent = `Enable ${meta.label}`;
    dom.permConfirmModal.classList.add('open');
    dom.permConfirmCheck.focus();
}
async function commitPermissionPreset(preset, scope) {
    const effectiveScope = scope === 'default'
        ? 'default'
        : (state.sessionId ? 'session' : 'default');
    if (effectiveScope === 'default') {
        state.defaultPermissionPreset = preset;
    }
    if (scope === 'session' || !state.sessionId) {
        applyPermissionPresetUi(preset);
    }
    else if (dom.settingsPermSelect) {
        dom.settingsPermSelect.value = state.defaultPermissionPreset;
    }
    const meta = getPresetMeta(preset);
    announceStatus(`Permission preset set to ${meta.label}`);
    const res = await fetch(apiUrl('/api/permissions'), {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
            preset,
            scope: effectiveScope,
            sessionId: effectiveScope === 'session' ? state.sessionId : undefined
        })
    }).catch(() => null);
    if (res && res.ok) {
        const data = await res.json().catch(() => null);
        if (data?.defaultPreset) {
            state.defaultPermissionPreset = normalizeClientPreset(data.defaultPreset);
        }
        if (data?.currentPreset && scope === 'session') {
            applyPermissionPresetUi(normalizeClientPreset(data.currentPreset));
        }
        else if (dom.settingsPermSelect) {
            dom.settingsPermSelect.value = state.defaultPermissionPreset;
        }
    }
}
function requestPresetChange(preset, scope) {
    closeAllPopovers();
    const current = scope === 'default' ? state.defaultPermissionPreset : state.permissionPreset;
    if (preset === current)
        return;
    const meta = getPresetMeta(preset);
    if (meta.requiresRiskConfirmation) {
        openPermissionConfirmModal(preset, scope);
        return;
    }
    void commitPermissionPreset(preset, scope);
}
function renderPermissionPopover() {
    dom.permPopover.textContent = '';
    for (const item of catalog) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `perm-option${item.id === state.permissionPreset ? ' active' : ''}`;
        btn.setAttribute('role', 'menuitemradio');
        btn.setAttribute('aria-checked', item.id === state.permissionPreset ? 'true' : 'false');
        btn.dataset.preset = item.id;
        btn.title = item.description;
        const left = document.createElement('span');
        left.className = 'perm-option-main';
        left.appendChild(createShieldSvg(item.id, 'perm-option-icon'));
        const label = document.createElement('span');
        label.className = 'perm-option-label';
        label.textContent = item.label;
        left.appendChild(label);
        btn.appendChild(left);
        if (item.id === state.permissionPreset) {
            btn.appendChild(createCheckSvg());
        }
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            requestPresetChange(item.id, 'session');
        });
        dom.permPopover.appendChild(btn);
    }
}
export async function loadPermissionPresets(sessionId) {
    const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
    const res = await fetch(apiUrl(`/api/permissions${qs}`), { headers: authHeaders() }).catch(() => null);
    if (!res || !res.ok) {
        applyPermissionPresetUi(state.permissionPreset);
        return;
    }
    const data = await res.json().catch(() => null);
    if (Array.isArray(data?.catalog) && data.catalog.length > 0) {
        catalog = data.catalog;
    }
    if (data?.defaultPreset) {
        state.defaultPermissionPreset = normalizeClientPreset(data.defaultPreset);
    }
    const active = data?.currentPreset
        ? normalizeClientPreset(data.currentPreset)
        : state.defaultPermissionPreset;
    applyPermissionPresetUi(active);
}
export function bindPermissionPresetEvents() {
    dom.permTriggerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (permLocked)
            return;
        const wasOpen = dom.permPopover.classList.contains('open');
        closeAllPopovers();
        if (!wasOpen) {
            renderPermissionPopover();
            dom.permTriggerBtn.classList.add('open');
            dom.permTriggerBtn.setAttribute('aria-expanded', 'true');
            positionPopover(dom.permPopover, dom.permTriggerBtn, true);
            const activeBtn = dom.permPopover.querySelector('.perm-option.active');
            activeBtn?.focus();
        }
    });
    dom.permPopover.addEventListener('keydown', (e) => {
        const items = Array.from(dom.permPopover.querySelectorAll('.perm-option'));
        if (items.length === 0)
            return;
        const idx = items.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            items[(idx + 1 + items.length) % items.length]?.focus();
        }
        else if (e.key === 'ArrowUp') {
            e.preventDefault();
            items[(idx - 1 + items.length) % items.length]?.focus();
        }
        else if (e.key === 'Escape') {
            e.preventDefault();
            closeAllPopovers();
            dom.permTriggerBtn.focus();
        }
    });
    dom.permConfirmCheck.addEventListener('change', () => {
        dom.permConfirmOk.disabled = !dom.permConfirmCheck.checked;
    });
    dom.permConfirmCancel.addEventListener('click', closePermissionConfirmModal);
    dom.permConfirmClose.addEventListener('click', closePermissionConfirmModal);
    dom.permConfirmModal.addEventListener('click', (e) => {
        if (e.target === dom.permConfirmModal)
            closePermissionConfirmModal();
    });
    dom.permConfirmOk.addEventListener('click', () => {
        if (!dom.permConfirmCheck.checked || !pendingConfirm)
            return;
        const { preset, scope } = pendingConfirm;
        pendingConfirm = null;
        dom.permConfirmModal.classList.remove('open');
        dom.permConfirmCheck.checked = false;
        dom.permConfirmOk.disabled = true;
        void commitPermissionPreset(preset, scope);
    });
    if (dom.settingsPermSelect) {
        dom.settingsPermSelect.addEventListener('change', () => {
            const chosen = normalizeClientPreset(dom.settingsPermSelect?.value);
            requestPresetChange(chosen, 'default');
        });
    }
}
