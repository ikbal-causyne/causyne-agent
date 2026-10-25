import { padEnd, safeDisplay, truncate } from './text.js';
// The terminal theme is still a standalone JavaScript module in the TS migration.
// @ts-expect-error theme.js has no TypeScript declaration yet.
import { bold, dim, fill, paint } from './theme.js';
export const SIDEBAR_WIDTH = 42;
export const SIDEBAR_THRESHOLD = 120;
/** A side panel is useful only when a readable conversation column remains. */
export function sidebarVisible(columns, home = false) {
    return !home && Number.isFinite(columns) && columns > SIDEBAR_THRESHOLD;
}
/** Reserve the last terminal column so a wide row cannot wrap the stage. */
export function sessionMainWidth(columns, home = false) {
    const width = Number.isFinite(columns) ? Math.max(20, Math.floor(columns)) : 80;
    return sidebarVisible(width, home) ? width - SIDEBAR_WIDTH - 1 : width;
}
/** The session input uses the available conversation column, with a small inset. */
export function sessionComposerWidth(columns) {
    return Number.isFinite(columns) ? Math.max(20, Math.floor(columns) - 3) : 77;
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
    if (limit > 0) {
        const percent = Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
        styled(dim(`${percent}% of available window`));
    }
    else {
        styled(dim('No context measurement yet'));
    }
    line();
    styled(bold('Model'));
    line([facts.provider, facts.model].filter(Boolean).join(' / ') || 'Not configured');
    line();
    styled(bold('Workspace'));
    line(facts.cwd || 'Unknown');
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
