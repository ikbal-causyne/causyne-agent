import { padEnd, safeDisplay, stripAnsi, truncate } from './text.js';
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
    const safeFacts = facts && typeof facts === 'object' ? facts : {};
    const count = Number.isFinite(height) ? Math.max(1, Math.floor(height)) : 1;
    const inner = SIDEBAR_WIDTH - 4;
    const rows = [];
    const oneLine = (value) => safeDisplay(value).replace(/[\r\n]+/g, ' ');
    const line = (value = '') => {
        const text = truncate(oneLine(value), inner, '…');
        rows.push(fill('surface', `${paint('rule', '│')}  ${padEnd(text, inner)} `));
    };
    const styled = (value) => {
        const clean = String(value == null ? '' : value).replace(/[\r\n]+/g, ' ');
        rows.push(fill('surface', `${paint('rule', '│')}  ${padEnd(truncate(clean, inner, '…'), inner)} `));
    };
    line();
    styled(bold(oneLine(safeFacts.title).trim() || 'Untitled'));
    if (safeFacts.id)
        line(safeFacts.id);
    line();
    styled(bold('Context'));
    const limit = Number.isFinite(safeFacts.contextLimit) ? Number(safeFacts.contextLimit) : 0;
    const used = Number.isFinite(safeFacts.contextChars) ? Number(safeFacts.contextChars) : 0;
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
    if (count >= 24 && safeFacts.provider && safeFacts.model) {
        line(safeFacts.provider);
        line(safeFacts.model);
    }
    else {
        line([safeFacts.provider, safeFacts.model].filter(Boolean).join(' / ') || 'Not configured');
    }
    line();
    styled(bold('Workspace'));
    line(safeFacts.cwd || 'Unknown');
    if (safeFacts.activeSkill) {
        const raw = safeFacts.activeSkill;
        const skillId = typeof raw === 'string' ? raw : (raw.id || raw.name || '');
        const skillDesc = typeof raw === 'object' && raw ? raw.description || '' : '';
        if (skillId) {
            line();
            styled(bold('Active Skill'));
            styled(paint('accent', `✦ ${truncate(oneLine(skillId), inner - 4, '…')}`));
            if (skillDesc) {
                line(truncate(oneLine(skillDesc), inner, '…'));
            }
        }
    }
    const validPlan = Array.isArray(safeFacts.plan)
        ? safeFacts.plan.filter((item) => Boolean(item && typeof item === 'object'))
        : [];
    if (validPlan.length) {
        const completed = validPlan.filter(item => item.status === 'completed').length;
        // Budget from the actual metadata, including optional skill/model rows.
        // Preserve space for the focused step and overflow summaries on short panes.
        const planBudget = Math.min(6, Math.max(0, count - 3));
        while (rows.length > count - planBudget) {
            const blank = rows.findIndex(row => stripAnsi(row).replace('│', '').trim() === '');
            if (blank < 0)
                break;
            rows.splice(blank, 1);
        }
        if (rows.length > count - planBudget)
            rows.length = Math.max(0, count - planBudget);
        styled(bold(`Plan  ${completed}/${validPlan.length}`));
        // Keep plan steps in execution order and keep the active step in view.
        const maxSteps = Math.max(1, Math.min(10, count - rows.length - 3));
        const activeIndex = validPlan.findIndex(item => item.status === 'in_progress');
        const pendingIndex = validPlan.findIndex(item => item.status !== 'completed');
        const focus = activeIndex >= 0 ? activeIndex : pendingIndex >= 0 ? pendingIndex : validPlan.length - 1;
        const start = Math.max(0, Math.min(focus - Math.min(2, maxSteps - 1), validPlan.length - maxSteps));
        const planItems = validPlan.slice(start, start + maxSteps);
        if (start > 0 && count - rows.length > planItems.length)
            line(`${start} earlier plan steps`);
        for (const item of planItems) {
            const mark = item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '▸' : '·';
            line(`${mark} ${item.text || item.step || item.content || ''}`);
        }
        const remaining = validPlan.length - start - planItems.length;
        if (remaining > 0)
            line(`${remaining} later plan steps`);
    }
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
    if (!Array.isArray(mainRows))
        return [];
    const safeSide = Array.isArray(sideRows) ? sideRows : [];
    const safeWidth = Number.isFinite(mainWidth) ? Math.max(1, Math.floor(mainWidth)) : 80;
    return mainRows.map((row, index) => {
        const cleanMain = String(row == null ? '' : row).replace(/[\r\n]+/g, ' ');
        const main = padEnd(truncate(cleanMain, safeWidth, ''), safeWidth);
        const rawSide = safeSide[index]
            ? String(safeSide[index]).replace(/[\r\n]+/g, ' ')
            : ' '.repeat(SIDEBAR_WIDTH);
        const side = padEnd(truncate(rawSide, SIDEBAR_WIDTH, ''), SIDEBAR_WIDTH);
        return main + side;
    });
}
