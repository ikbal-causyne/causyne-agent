// Collapsible & auto-scrolling thinking box container for Causyne Agent TUI.
//
// Encapsulates streaming reasoning into a bounded, scrolling card container
// with rounded border framing, auto-scrolling tail pinning, and interactive
// collapse/expand folding.
//
// Pure TypeScript under strict mode.
// @ts-expect-error theme.js has no TypeScript declaration yet.
import { paint, bold, dim, GLYPHS, HAS_UNICODE } from './theme.js';
import { padEnd, truncate, visibleWidth, wrapBlock } from './text.js';
export const DEFAULT_MAX_STREAMING_LINES = 8;
export const DEFAULT_MAX_EXPANDED_LINES = 12;
/**
 * Single-line compact badge for collapsed reasoning frames.
 */
export function renderCollapsedThinkingBadge(options, totalLines) {
    const isStreaming = Boolean(options.streaming);
    const durationText = options.durationText ? String(options.durationText).trim() : '';
    const arrow = HAS_UNICODE ? '▸' : '>';
    if (isStreaming) {
        const timePart = durationText ? ` · ${durationText}` : '';
        return `  ${paint('warn', arrow)} ${bold(paint('warn', 'thinking…'))}${dim(timePart)} ${dim('· click to expand')}`;
    }
    const timePart = durationText ? ` for ${durationText}` : '';
    const lineWord = totalLines === 1 ? 'line' : 'lines';
    return `  ${paint('muted', arrow)} ${dim(`Thought${timePart}`)} ${dim(`(${totalLines} ${lineWord})`)} ${dim('· click to expand')}`;
}
/**
 * Builds the top, bottom, and side frame borders for the thinking box.
 */
export function buildThinkingBoxBorders(title, footer, width, role = 'rule') {
    const w = Math.max(20, Math.floor(width));
    const inner = w - 2; // total space between left and right outer border corners
    const h = GLYPHS.hLine || '─';
    const v = GLYPHS.vLine || '│';
    const tl = GLYPHS.topLeft || '╭';
    const tr = GLYPHS.topRight || '╮';
    const bl = GLYPHS.bottomLeft || '╰';
    const br = GLYPHS.bottomRight || '╯';
    // --- Top Border ---
    const rawTitle = title ? ` ${title} ` : '';
    const titleVis = visibleWidth(rawTitle);
    const maxTitleVis = Math.max(0, inner - 4); // reserve at least 1 leading hLine and 2 trailing hLines
    const safeTitle = titleVis > maxTitleVis ? (rawTitle ? ` ${truncate(title, Math.max(4, maxTitleVis - 2), GLYPHS.ellipsis || '…')} ` : '') : rawTitle;
    const safeTitleVis = visibleWidth(safeTitle);
    const topLead = h;
    const topTrailCount = Math.max(0, inner - 1 - safeTitleVis);
    const topTrail = h.repeat(topTrailCount);
    const top = paint(role, tl + topLead) + safeTitle + paint(role, topTrail + tr);
    // --- Bottom Border ---
    const rawFooter = footer ? ` ${footer} ` : '';
    const footerVis = visibleWidth(rawFooter);
    const maxFooterVis = Math.max(0, inner - 4);
    const safeFooter = footerVis > maxFooterVis ? (rawFooter ? ` ${truncate(footer, Math.max(4, maxFooterVis - 2), GLYPHS.ellipsis || '…')} ` : '') : rawFooter;
    const safeFooterVis = visibleWidth(safeFooter);
    const bottomLead = h;
    const bottomTrailCount = Math.max(0, inner - 1 - safeFooterVis);
    const bottomTrail = h.repeat(bottomTrailCount);
    const bottom = paint(role, bl + bottomLead) + safeFooter + paint(role, bottomTrail + br);
    // --- Middle Row Wrapper ---
    // Format: "│ " + content + " │"
    // content column width = inner - 2 = w - 4
    const contentWidth = Math.max(2, inner - 2);
    const side = paint(role, v);
    const wrapRow = (line) => {
        const truncated = truncate(line, contentWidth, GLYPHS.ellipsis || '…');
        const padded = padEnd(truncated, contentWidth);
        return `${side} ${padded} ${side}`;
    };
    return { top, bottom, wrapRow };
}
/**
 * Render a complete thinking frame (either compact collapsed badge or expanded box).
 */
export function renderThinkingFrame(content, options = {}) {
    const text = String(content ?? '').trim();
    if (!text)
        return [];
    const width = Math.max(20, Math.floor(options.width ?? 80));
    const isStreaming = Boolean(options.streaming);
    const isCollapsed = Boolean(options.collapsed);
    const durationText = options.durationText ? String(options.durationText).trim() : '';
    // Wrap lines for inner box width (w - 4)
    const contentBudget = Math.max(10, width - 4);
    const allRows = wrapBlock(text, contentBudget);
    const totalLines = allRows.length;
    if (isCollapsed) {
        return [renderCollapsedThinkingBadge(options, totalLines)];
    }
    // Expanded Box Mode
    const role = isStreaming ? 'warn' : (options.role ?? 'rule');
    const collapseIndicator = HAS_UNICODE ? '▾' : 'v';
    const collapseHint = dim(`${collapseIndicator} click to collapse`);
    if (isStreaming) {
        const maxLines = options.maxVisibleLines ?? DEFAULT_MAX_STREAMING_LINES;
        const timePart = durationText ? ` · ${durationText}` : '';
        const title = `${bold(paint('warn', 'thinking…'))}${dim(timePart)}`;
        const footer = collapseHint;
        const { top, bottom, wrapRow } = buildThinkingBoxBorders(title, footer, width, role);
        const rows = [top];
        if (totalLines > maxLines) {
            const hiddenCount = totalLines - (maxLines - 1);
            const scrollIndicator = HAS_UNICODE ? '↑' : '^';
            const hiddenNotice = `${paint('rule', scrollIndicator)} ${dim(`${hiddenCount} earlier thinking line${hiddenCount === 1 ? '' : 's'} scrolled`)}`;
            rows.push(wrapRow(hiddenNotice));
            const tailRows = allRows.slice(totalLines - (maxLines - 1));
            for (const row of tailRows) {
                rows.push(wrapRow(dim(row)));
            }
        }
        else {
            for (const row of allRows) {
                rows.push(wrapRow(dim(row)));
            }
        }
        rows.push(bottom);
        return rows;
    }
    // Completed Expanded Mode
    const maxLines = options.maxVisibleLines ?? DEFAULT_MAX_EXPANDED_LINES;
    const timePart = durationText ? ` · ${durationText}` : '';
    const title = `${paint('muted', 'thinking')}${dim(timePart)} ${dim(`(${totalLines} line${totalLines === 1 ? '' : 's'})`)}`;
    const { top, bottom, wrapRow } = buildThinkingBoxBorders(title, collapseHint, width, 'rule');
    const rows = [top];
    if (totalLines > maxLines) {
        const hiddenCount = totalLines - maxLines;
        const displayRows = allRows.slice(0, maxLines);
        for (const row of displayRows) {
            rows.push(wrapRow(dim(row)));
        }
        const moreNotice = `${GLYPHS.ellipsis || '…'} ${hiddenCount} more line${hiddenCount === 1 ? '' : 's'} of reasoning`;
        rows.push(wrapRow(dim(moreNotice)));
    }
    else {
        for (const row of allRows) {
            rows.push(wrapRow(dim(row)));
        }
    }
    rows.push(bottom);
    return rows;
}
