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

export interface ThinkingFrameOptions {
  width?: number;
  streaming?: boolean;
  durationText?: string;
  collapsed?: boolean;
  maxVisibleLines?: number;
  role?: string;
  startLine?: number;
  activity?: string;
  title?: string;
  completedTitle?: string;
}

export const DEFAULT_MAX_STREAMING_LINES = 8;
export const DEFAULT_MAX_EXPANDED_LINES = 12;

/**
 * Calculates total wrapped lines for reasoning content under the thinking box budget.
 */
export function calculateThinkingLineCount(content: string, width: number): number {
  const text = String(content ?? '').trim();
  if (!text) return 0;
  const safeWidth = Math.max(20, Math.floor(width));
  const contentBudget = Math.max(10, safeWidth - 4);
  return wrapBlock(text, contentBudget).length;
}

/**
 * Resolves dynamic contextual activity labels for streaming and completed badges.
 */
export function resolveActivityLabels(options: ThinkingFrameOptions): {
  activeLabel: string;
  completedLabel: string;
} {
  const raw = (options.activity || options.title || 'thinking')
    .replace(/…|\.\.\.$/, '')
    .trim()
    .toLowerCase();

  let active = options.title ? options.title.trim() : `${raw}…`;
  if (!options.title) {
    if (raw === 'thinking') active = 'thinking…';
    else if (raw === 'analyzing') active = 'analyzing…';
    else if (raw === 'executing') active = 'executing…';
    else if (raw === 'editing') active = 'editing…';
    else if (raw === 'planning') active = 'planning…';
    else if (raw === 'researching') active = 'researching…';
    else if (raw === 'synthesizing') active = 'synthesizing…';
    else if (raw === 'processing') active = 'processing…';
    else active = `${raw}…`;
  }

  let completed = options.completedTitle ? options.completedTitle.trim() : '';
  if (!completed) {
    if (raw === 'thinking') completed = 'Thought';
    else if (raw === 'analyzing') completed = 'Analyzed';
    else if (raw === 'executing') completed = 'Executed';
    else if (raw === 'editing') completed = 'Edited';
    else if (raw === 'planning') completed = 'Planned';
    else if (raw === 'researching') completed = 'Researched';
    else if (raw === 'synthesizing') completed = 'Synthesized';
    else if (raw === 'processing') completed = 'Processed';
    else completed = raw.charAt(0).toUpperCase() + raw.slice(1);
  }

  return { activeLabel: active, completedLabel: completed };
}

/**
 * Single-line compact badge for collapsed reasoning frames.
 */
export function renderCollapsedThinkingBadge(
  options: ThinkingFrameOptions,
  totalLines: number
): string {
  const isStreaming = Boolean(options.streaming);
  const durationText = options.durationText ? String(options.durationText).trim() : '';
  const arrow = HAS_UNICODE ? '▸' : '>';
  const { activeLabel, completedLabel } = resolveActivityLabels(options);

  if (isStreaming) {
    const timePart = durationText ? ` · ${durationText}` : '';
    return `  ${paint('warn', arrow)} ${bold(paint('warn', activeLabel))}${dim(timePart)} ${dim('· click to expand')}`;
  }

  const timePart = durationText ? ` for ${durationText}` : '';
  const lineWord = totalLines === 1 ? 'line' : 'lines';
  return `  ${paint('muted', arrow)} ${dim(`${completedLabel}${timePart}`)} ${dim(`(${totalLines} ${lineWord})`)} ${dim('· click to expand')}`;
}

/**
 * Builds the top, bottom, and side frame borders for the thinking box.
 */
export function buildThinkingBoxBorders(
  title: string,
  footer: string,
  width: number,
  role: string = 'rule'
): {
  top: string;
  bottom: string;
  wrapRow: (line: string) => string;
} {
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

  const wrapRow = (line: string): string => {
    const truncated = truncate(line, contentWidth, GLYPHS.ellipsis || '…');
    const padded = padEnd(truncated, contentWidth);
    return `${side} ${padded} ${side}`;
  };

  return { top, bottom, wrapRow };
}

/**
 * Render a complete thinking frame (either compact collapsed badge or expanded box).
 */
export function renderThinkingFrame(
  content: string,
  options: ThinkingFrameOptions = {}
): string[] {
  const text = String(content ?? '').trim();
  if (!text) return [];

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
    const { activeLabel } = resolveActivityLabels(options);
    const title = `${bold(paint('warn', activeLabel))}${dim(timePart)}`;
    const footer = collapseHint;

    const { top, bottom, wrapRow } = buildThinkingBoxBorders(title, footer, width, role);
    const rows: string[] = [top];

    if (totalLines > maxLines) {
      const hiddenCount = totalLines - (maxLines - 1);
      const scrollIndicator = HAS_UNICODE ? '↑' : '^';
      const activityWord = options.activity || options.title ? `${(options.activity || options.title || '').replace(/…|\.\.\.$/, '').trim()} ` : 'thinking ';
      const hiddenNotice = `${paint('rule', scrollIndicator)} ${dim(`${hiddenCount} earlier ${activityWord}line${hiddenCount === 1 ? '' : 's'} scrolled`)}`;
      rows.push(wrapRow(hiddenNotice));

      const tailRows = allRows.slice(totalLines - (maxLines - 1));
      for (const row of tailRows) {
        rows.push(wrapRow(dim(row)));
      }
    } else {
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
  const raw = (options.activity || options.title || 'thinking')
    .replace(/…|\.\.\.$/, '')
    .trim()
    .toLowerCase();
  const expandedTitleLabel = options.completedTitle
    ? options.completedTitle.toLowerCase()
    : (raw === 'thinking' ? 'thinking' : raw);
  const title = `${paint('muted', expandedTitleLabel)}${dim(timePart)} ${dim(`(${totalLines} line${totalLines === 1 ? '' : 's'})`)}`;

  const { top, bottom, wrapRow } = buildThinkingBoxBorders(title, collapseHint, width, 'rule');
  const rows: string[] = [top];

  if (totalLines > maxLines) {
    const limit = Math.max(0, totalLines - maxLines);
    const start = Math.max(0, Math.min(limit, Math.floor(options.startLine ?? 0)));
    const visible = allRows.slice(start, start + maxLines);

    for (const row of visible) {
      rows.push(wrapRow(dim(row)));
    }

    const hiddenBelow = totalLines - (start + visible.length);
    if (hiddenBelow > 0) {
      const moreNotice = `${GLYPHS.ellipsis || '…'} ${hiddenBelow} more line${hiddenBelow === 1 ? '' : 's'} of reasoning`;
      rows.push(wrapRow(dim(moreNotice)));
    } else if (start > 0) {
      const earlierNotice = `${HAS_UNICODE ? '↑' : '^'} ${start} earlier line${start === 1 ? '' : 's'} scrolled above`;
      rows.push(wrapRow(dim(earlierNotice)));
    }

    const upArrow = start > 0 ? (HAS_UNICODE ? '↑ ' : '^ ') : '';
    const downArrow = start + visible.length < totalLines ? (HAS_UNICODE ? ' ↓' : ' v') : '';
    const scrollInfo = `${upArrow}lines ${start + 1}–${start + visible.length} of ${totalLines}${downArrow} · scroll over thinking`;
    rows.push(wrapRow(dim(scrollInfo)));
  } else {
    for (const row of allRows) {
      rows.push(wrapRow(dim(row)));
    }
  }

  rows.push(bottom);
  return rows;
}
