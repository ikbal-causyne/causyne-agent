import { padEnd, safeDisplay, truncate } from './text.js';
// The terminal theme is still a standalone JavaScript module in the TS migration.
// @ts-expect-error theme.js has no TypeScript declaration yet.
import { bold, dim, fill, paint } from './theme.js';
export const SIDEBAR_WIDTH = 42;
// A 42-column sidebar is only useful if the conversation retains a readable width.
// Narrow IDE terminals should prioritize the user's complete message over metadata.
export const SIDEBAR_THRESHOLD = 160;
/** A side panel is useful only when a readable conversation column remains. */
export function sidebarVisible(columns, home = false, env = typeof process !== 'undefined' ? process.env : {}) {
    if (env) {
        const setting = String(env.CAUSYNE_SIDEBAR ?? '').trim().toLowerCase();
        if (setting === 'off' || setting === '0' || setting === 'false')
            return false;
    }
    return !home && Number.isFinite(columns) && columns > SIDEBAR_THRESHOLD;
}
/** Reserve the last terminal column so a wide row cannot wrap the stage. */
export function sessionMainWidth(columns, home = false, env = typeof process !== 'undefined' ? process.env : {}) {
    const width = Number.isFinite(columns) ? Math.max(20, Math.floor(columns)) : 80;
    return sidebarVisible(width, home, env) ? width - SIDEBAR_WIDTH - 1 : width;
}
/** The session input uses the available conversation column, with a small inset. */
export function sessionComposerWidth(columns) {
    const available = Number.isFinite(columns) ? Math.max(20, Math.floor(columns)) : 80;
    if (available <= 112) {
        return Math.max(20, available - 4);
    }
    // Dynamic readable measure scaling on wide terminals:
    const readableMeasure = Math.round(109 + 20 * Math.log2(available / 112));
    return Math.min(available - 4, Math.max(20, readableMeasure));
}
/** Render only facts the runtime can actually report. */
export function sessionSidebarRows(facts, height) {
    const inner = SIDEBAR_WIDTH - 4;
    const rows = [];
    const line = (value = '') => {
        const text = truncate(safeDisplay(value), inner, '…');
        rows.push(fill('surface', `${paint('rule', '│')}  ${padEnd(text, inner)} `));
    };
    const styled = (value) => {
        rows.push(fill('surface', `${paint('rule', '│')}  ${padEnd(truncate(value, inner, '…'), inner)} `));
    };
    line();
    styled(bold(safeDisplay(facts.title?.trim() || 'Untitled')));
    if (facts.id)
        line(facts.id);
    line();
    styled(bold('Context'));
    const limit = Number.isFinite(facts.contextLimit) ? Number(facts.contextLimit) : 0;
    const used = Number.isFinite(facts.contextChars) ? Number(facts.contextChars) : 0;
    if (limit > 0 && used > 0) {
        const rawPercent = (used / limit) * 100;
        const percent = Math.max(1, Math.min(100, Math.round(rawPercent)));
        styled(dim(`${percent}% of available window`));
    }
    else {
        styled(dim('No context measurement yet'));
    }
    line();
    styled(bold('Model'));
    if (height >= 24 && facts.provider && facts.model) {
        line(facts.provider);
        line(facts.model);
    }
    else {
        line([facts.provider, facts.model].filter(Boolean).join(' / ') || 'Not configured');
    }
    line();
    styled(bold('Workspace'));
    line(facts.cwd || 'Unknown');
    if (facts.activeSkill) {
        const raw = facts.activeSkill;
        const skillId = typeof raw === 'string' ? raw : (raw.id || raw.name || '');
        const skillDesc = typeof raw === 'object' && raw ? raw.description || '' : '';
        if (skillId) {
            line();
            styled(bold('Active Skill'));
            styled(paint('accent', `✦ ${truncate(safeDisplay(skillId), inner - 4, '…')}`));
            if (skillDesc) {
                line(truncate(skillDesc, inner, '…'));
            }
        }
    }
    if (facts.plan?.length) {
        const completed = facts.plan.filter(item => item.status === 'completed').length;
        line();
        styled(bold(`Plan  ${completed}/${facts.plan.length}`));
        // Keep plan steps in execution order and keep the active step in view.
        const maxSteps = Math.max(2, Math.min(10, Math.floor(height) - 14));
        const activeIndex = facts.plan.findIndex(item => item.status === 'in_progress');
        const pendingIndex = facts.plan.findIndex(item => item.status !== 'completed');
        const focus = activeIndex >= 0 ? activeIndex : pendingIndex >= 0 ? pendingIndex : facts.plan.length - 1;
        const start = Math.max(0, Math.min(focus - 2, facts.plan.length - maxSteps));
        const planItems = facts.plan.slice(start, start + maxSteps);
        if (start > 0)
            line(`${start} earlier plan steps`);
        for (const item of planItems) {
            const mark = item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '▸' : '·';
            line(`${mark} ${item.text || item.step || item.content || ''}`);
        }
        const remaining = facts.plan.length - start - planItems.length;
        if (remaining > 0)
            line(`${remaining} later plan steps`);
    }
    const count = Number.isFinite(height) ? Math.max(1, Math.floor(height)) : 1;
    const visible = rows.slice(0, count);
    while (visible.length < count - 1)
        lineFor(visible);
    if (visible.length < count)
        visible.push(fill('surface', `${paint('rule', '│')}  ${padEnd(dim('Causyne Agent'), inner)} `));
    return visible;
}
function lineFor(rows) {
    rows.push(fill('surface', `${paint('rule', '│')}${' '.repeat(SIDEBAR_WIDTH - 1)}`));
}
/** Compose the panel beside the viewport and input without exceeding terminal width. */
export function joinSessionSidebar(mainRows, sideRows, mainWidth) {
    return mainRows.map((row, index) => {
        const main = padEnd(truncate(row, Math.max(1, mainWidth), ''), mainWidth);
        return main + (sideRows[index] || ' '.repeat(SIDEBAR_WIDTH));
    });
}
