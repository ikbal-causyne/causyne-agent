// Collapsible & auto-scrolling thinking box container for Causyne Agent TUI.
//
// Encapsulates streaming reasoning into a bounded, scrolling card container
// with rounded border framing, auto-scrolling tail pinning, and interactive
// collapse/expand folding.
//
// Pure TypeScript under strict mode.

// @ts-expect-error theme.js has no TypeScript declaration yet.
import { paint, dim, GLYPHS, HAS_UNICODE } from './theme.js';
import { padEnd, safeDisplay, truncate, visibleWidth, wrapBlock } from './text.js';
import { renderRunningLight } from './runningLight.js';

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
  nowMs?: number;
  tick?: number;
}

export const DEFAULT_MAX_STREAMING_LINES = 8;
export const DEFAULT_MAX_EXPANDED_LINES = 12;

function clampThinkingWidth(width: number | undefined): number {
  const numeric = Number(width ?? 80);
  return Number.isFinite(numeric) ? Math.max(20, Math.floor(numeric)) : 80;
}

function clampMaxVisibleLines(value: number | undefined, fallback: number): number {
  if (value === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  const numeric = Number(value ?? fallback);
  return Number.isFinite(numeric) ? Math.max(1, Math.floor(numeric)) : fallback;
}

function cleanSingleLine(value: string | undefined): string {
  return safeDisplay(String(value ?? '')).replace(/\s+/g, ' ').trim();
}

function resolveShimmerNowMs(options: ThinkingFrameOptions): number {
  if (typeof options.nowMs === 'number' && Number.isFinite(options.nowMs)) {
    return options.nowMs;
  }
  if (typeof options.tick === 'number' && Number.isFinite(options.tick)) {
    return options.tick * 80;
  }
  return 320;
}

/**
 * Calculates total wrapped lines for reasoning content under the thinking box budget.
 */
export function calculateThinkingLineCount(content: string, width: number): number {
  const text = safeDisplay(String(content ?? '')).trim();
  if (!text) return 0;
  const safeWidth = clampThinkingWidth(width);
  const contentBudget = Math.max(10, safeWidth - 4);
  return wrapBlock(text, contentBudget, { hang: 0 }).length;
}

function stripTrailingEllipsis(value: string | undefined): string {
  let text = cleanSingleLine(value);
  while (text.endsWith('…') || text.endsWith('...')) {
    text = (text.endsWith('...') ? text.slice(0, -3) : text.slice(0, -1)).trimEnd();
  }
  return text.trim();
}

const COMPLETED_ACTIVITY_LABELS = new Map<string, string>([
  ['thinking', 'Thought'],
  ['analyzing', 'Analyzed'],
  ['executing', 'Executed'],
  ['editing', 'Edited'],
  ['planning', 'Planned'],
  ['researching', 'Researched'],
  ['synthesizing', 'Synthesized'],
  ['processing', 'Processed']
]);

/**
 * Resolves dynamic contextual activity labels for streaming and completed badges.
 */
export function resolveActivityLabels(options: ThinkingFrameOptions): {
  activeLabel: string;
  completedLabel: string;
} {
  const safeOptions: ThinkingFrameOptions = options && typeof options === 'object' ? options : {};
  const cleanedActivity = stripTrailingEllipsis(safeOptions.activity);
  const cleanedTitle = stripTrailingEllipsis(safeOptions.title);
  const raw = (cleanedActivity || cleanedTitle || 'thinking').toLowerCase();

  const rawTitle = cleanedTitle && safeOptions.title ? cleanSingleLine(safeOptions.title) : '';
  const active = rawTitle || `${raw}…`;

  let completed = safeOptions.completedTitle ? cleanSingleLine(safeOptions.completedTitle) : '';
  if (!completed) {
    completed =
      COMPLETED_ACTIVITY_LABELS.get(raw) ?? raw.charAt(0).toUpperCase() + raw.slice(1);
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
  options = options && typeof options === 'object' ? options : {};
  const isStreaming = Boolean(options.streaming);
  const durationText = options.durationText ? cleanSingleLine(options.durationText) : '';
  const arrow = HAS_UNICODE ? '▸' : '>';
  const { activeLabel, completedLabel } = resolveActivityLabels(options);
  const safeTotalLines = Number.isFinite(totalLines) ? Math.max(0, Math.floor(totalLines)) : 0;

  if (isStreaming) {
    const timePart = durationText ? ` · ${durationText}` : '';
    const shimmerNowMs = resolveShimmerNowMs(options);
    const styledLabel = renderRunningLight(activeLabel, {
      nowMs: shimmerNowMs,
      baseRole: 'warn',
      boldActive: true
    });
    return `${paint('warn', arrow)} ${styledLabel}${dim(timePart)} ${dim('· click to expand')}`;
  }

  const timePart = durationText ? ` for ${durationText}` : '';
  const lineWord = safeTotalLines === 1 ? 'line' : 'lines';
  return `${paint('muted', arrow)} ${dim(`${completedLabel}${timePart}`)} ${dim(`(${safeTotalLines} ${lineWord})`)} ${dim('· click to expand')}`;
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
  const w = clampThinkingWidth(width);
  const inner = w - 2; // total space between left and right outer border corners

  const h = GLYPHS.hLine || '─';
  const v = GLYPHS.vLine || '│';
  const tl = GLYPHS.topLeft || '╭';
  const tr = GLYPHS.topRight || '╮';
  const bl = GLYPHS.bottomLeft || '╰';
  const br = GLYPHS.bottomRight || '╯';

  const buildBorderRow = (leftCorner: string, rightCorner: string, rawText: unknown): string => {
    const cleanText = safeDisplay(String(rawText ?? '')).replace(/[\r\n]+/g, ' ');
    const paddedText = cleanText ? ` ${cleanText} ` : '';
    const textVis = visibleWidth(paddedText);
    const maxTextVis = Math.max(0, inner - 4); // reserve at least 1 leading hLine and 2 trailing hLines
    const safeText =
      textVis > maxTextVis
        ? (paddedText ? ` ${truncate(cleanText, Math.max(4, maxTextVis - 2), GLYPHS.ellipsis || '…')} ` : '')
        : paddedText;
    const closedText =
      safeText.includes('\x1b[') && !safeText.endsWith('\x1b[0m') ? `${safeText}\x1b[0m` : safeText;
    const safeTextVis = visibleWidth(closedText);
    const trailCount = Math.max(0, inner - 1 - safeTextVis);
    return paint(role, leftCorner + h) + closedText + paint(role, h.repeat(trailCount) + rightCorner);
  };

  // --- Top Border ---
  const top = buildBorderRow(tl, tr, title);

  // --- Bottom Border ---
  const bottom = buildBorderRow(bl, br, footer);

  // --- Middle Row Wrapper ---
  // Format: "│ " + content + " │"
  // content column width = inner - 2 = w - 4
  const contentWidth = Math.max(2, inner - 2);
  const side = paint(role, v);

  const wrapRow = (line: string): string => {
    const truncated = truncate(line, contentWidth, GLYPHS.ellipsis || '…');
    const closed =
      truncated.includes('\x1b[') && !truncated.endsWith('\x1b[0m')
        ? `${truncated}\x1b[0m`
        : truncated;
    const padded = padEnd(closed, contentWidth);
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
  const text = safeDisplay(String(content ?? '')).trim();
  if (!text) return [];

  options = options && typeof options === 'object' ? options : {};
  const width = clampThinkingWidth(options.width);
  const isStreaming = Boolean(options.streaming);
  const isCollapsed = Boolean(options.collapsed);
  const durationText = options.durationText ? cleanSingleLine(options.durationText) : '';

  // Wrap lines for inner box width (w - 4) with zero hanging indent
  const contentBudget = Math.max(10, width - 4);
  const allRows = wrapBlock(text, contentBudget, { hang: 0 });
  const totalLines = allRows.length;

  if (isCollapsed) {
    return [renderCollapsedThinkingBadge(options, totalLines)];
  }

  // Expanded Box Mode
  const role = isStreaming ? 'warn' : (options.role ?? 'rule');
  const collapseIndicator = HAS_UNICODE ? '▾' : 'v';
  const collapseHint = dim(`${collapseIndicator} click to collapse`);

  if (isStreaming) {
    const maxLines = clampMaxVisibleLines(options.maxVisibleLines, DEFAULT_MAX_STREAMING_LINES);
    const timePart = durationText ? ` · ${durationText}` : '';
    const { activeLabel } = resolveActivityLabels(options);
    const shimmerNowMs = resolveShimmerNowMs(options);
    const styledActiveLabel = renderRunningLight(activeLabel, {
      nowMs: shimmerNowMs,
      baseRole: 'warn',
      boldActive: true
    });
    const title = `${styledActiveLabel}${dim(timePart)}`;
    const footer = collapseHint;

    const { top, bottom, wrapRow } = buildThinkingBoxBorders(title, footer, width, role);
    const rows: string[] = [top];

    const renderStreamingRow = (row: string, isActiveTail: boolean): string => {
      if (!isActiveTail) return wrapRow(dim(row));
      const truncated = truncate(row, contentBudget, GLYPHS.ellipsis || '…');
      const shimmered = renderRunningLight(truncated, {
        nowMs: shimmerNowMs,
        baseRole: 'muted'
      });
      return wrapRow(shimmered);
    };

    if (totalLines > maxLines) {
      const tailCount = Math.max(1, maxLines - 1);
      const hiddenCount = Math.max(0, totalLines - tailCount);
      const scrollIndicator = HAS_UNICODE ? '↑' : '^';
      const cleanedLabel = stripTrailingEllipsis(options.activity) || stripTrailingEllipsis(options.title) || 'thinking';
      const activityWord = `${cleanedLabel} `;
      const hiddenNotice = `${paint('rule', scrollIndicator)} ${dim(`${hiddenCount} earlier ${activityWord}line${hiddenCount === 1 ? '' : 's'} scrolled`)}`;
      rows.push(wrapRow(hiddenNotice));

      const tailRows = allRows.slice(totalLines - tailCount);
      for (let i = 0; i < tailRows.length; i++) {
        rows.push(renderStreamingRow(tailRows[i]!, i === tailRows.length - 1));
      }
    } else {
      for (let i = 0; i < allRows.length; i++) {
        rows.push(renderStreamingRow(allRows[i]!, i === allRows.length - 1));
      }
    }

    rows.push(bottom);
    return rows;
  }

  // Completed Expanded Mode
  const maxLines = clampMaxVisibleLines(options.maxVisibleLines, DEFAULT_MAX_EXPANDED_LINES);
  const timePart = durationText ? ` · ${durationText}` : '';
  const raw = (stripTrailingEllipsis(options.activity) || stripTrailingEllipsis(options.title) || 'thinking').toLowerCase();
  const trimmedCompleted = options.completedTitle ? cleanSingleLine(options.completedTitle) : '';
  const expandedTitleLabel = trimmedCompleted
    ? trimmedCompleted.toLowerCase()
    : (raw === 'thinking' ? 'thinking' : raw);
  const title = `${paint('muted', expandedTitleLabel)}${dim(timePart)} ${dim(`(${totalLines} line${totalLines === 1 ? '' : 's'})`)}`;

  const { top, bottom, wrapRow } = buildThinkingBoxBorders(title, collapseHint, width, 'rule');
  const rows: string[] = [top];

  if (totalLines > maxLines) {
    const limit = Math.max(0, totalLines - maxLines);
    const rawStart = Number(options.startLine ?? 0);
    const start = Math.max(0, Math.min(limit, Number.isFinite(rawStart) ? Math.floor(rawStart) : 0));
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
