import { truncate, visibleWidth, wrapBlock, stripAnsi, padEnd } from './text.js';
// @ts-expect-error untyped local TUI theme
import { paint, bold, dim, GLYPHS } from './theme.js';

export interface SessionTurn {
  turnIndex: number; // 1-based (1..N)
  totalTurns: number;
  userPrompt: string;
  assistantSummary: string;
  timestamp: number;
  formattedDate: string;
  frameId: number;
  startRow: number;
}

export interface TurnRailLayout {
  railX: number;
  stageTop: number;
  viewportHeight: number;
  dotRows: Map<number, number>; // turnIndex -> screenY
  rowToTurn: Map<number, number>; // screenY -> turnIndex
}

export function formatTurnTimestamp(ts: number): string {
  if (!ts || !Number.isFinite(ts)) return '';
  const date = new Date(ts);
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  if (sameDay) {
    return timeStr;
  }
  const dateStr = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  return `${dateStr} at ${timeStr}`;
}

/**
 * Collect all user turns from transcript frames.
 */
export function collectSessionTurns(transcript: any, contentWidth = 80): SessionTurn[] {
  if (!transcript || !Array.isArray(transcript.frames) || transcript.frames.length === 0) {
    return [];
  }
  const flat = typeof transcript.flatten === 'function' ? transcript.flatten(contentWidth) : null;
  const markers: Array<{ id: number; row: number; kind: string }> = flat?.markers || [];
  const frames: any[] = transcript.frames;

  const userFrames: Array<{ frame: any; index: number }> = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f && f.kind === 'user') {
      userFrames.push({ frame: f, index: i });
    }
  }

  const totalTurns = userFrames.length;
  if (totalTurns === 0) return [];

  const turns: SessionTurn[] = [];
  for (let k = 0; k < userFrames.length; k++) {
    const item = userFrames[k];
    if (!item) continue;
    const { frame, index } = item;
    const turnIndex = k + 1;
    const nextUserFrameIndex = k + 1 < userFrames.length ? userFrames[k + 1]!.index : frames.length;

    let userPrompt = typeof frame.meta?.messageText === 'string' ? frame.meta.messageText : '';
    if (!userPrompt && typeof frame.produce === 'function') {
      const rows = frame.produce(contentWidth) || [];
      userPrompt = stripAnsi(rows.join(' ')).trim();
    }

    let assistantSummary = '';
    for (let j = index + 1; j < nextUserFrameIndex; j++) {
      const cand = frames[j];
      if (cand && (cand.kind === 'assistant' || typeof cand.meta?.messageText === 'string')) {
        assistantSummary = typeof cand.meta?.messageText === 'string'
          ? cand.meta.messageText
          : stripAnsi((cand.produce?.(contentWidth) || []).join(' ')).trim();
        break;
      }
    }

    const marker = markers.find((m) => m.id === frame.id);
    const startRow = marker ? marker.row : 0;

    turns.push({
      turnIndex,
      totalTurns,
      userPrompt: userPrompt.replace(/\s+/g, ' ').trim(),
      assistantSummary: assistantSummary.replace(/\s+/g, ' ').trim(),
      timestamp: frame.ts || Date.now(),
      formattedDate: formatTurnTimestamp(frame.ts || Date.now()),
      frameId: frame.id,
      startRow
    });
  }

  return turns;
}

/**
 * Build the vertical column of turn rail cells.
 */
export function buildTurnRailCells(
  turns: SessionTurn[],
  height: number,
  activeTurnIndex: number,
  hoveredTurnIndex: number | null
): { cells: string[]; layout: { dotRows: Map<number, number>; rowToTurn: Map<number, number> } } {
  const cells: string[] = new Array(Math.max(0, height)).fill(' ');
  const dotRows = new Map<number, number>();
  const rowToTurn = new Map<number, number>();

  if (turns.length === 0 || height <= 0) {
    return { cells, layout: { dotRows, rowToTurn } };
  }

  const count = turns.length;
  // If count fits comfortably, stack consecutive dots centered or top-aligned
  const startRow = count <= height
    ? Math.max(0, Math.floor((height - count) / 3))
    : 0;

  for (let i = 0; i < count; i++) {
    const turn = turns[i];
    if (!turn) continue;
    const turnNum = turn.turnIndex;

    let rowIdx: number;
    if (count <= height) {
      rowIdx = startRow + i;
    } else {
      rowIdx = Math.round((i / (count - 1)) * (height - 1));
    }
    rowIdx = Math.max(0, Math.min(height - 1, rowIdx));

    dotRows.set(turnNum, rowIdx);
    rowToTurn.set(rowIdx, turnNum);

    const isHovered = hoveredTurnIndex === turnNum;
    const isActive = activeTurnIndex === turnNum || (turnNum === count && !hoveredTurnIndex);

    if (isHovered) {
      // Hovered dot: bright silver highlighted circle
      cells[rowIdx] = '\x1b[1m\x1b[38;2;230;235;245m●\x1b[0m';
    } else if (isActive) {
      // Active / current turn: bright white circle
      cells[rowIdx] = '\x1b[1m\x1b[38;2;250;250;250m●\x1b[0m';
    } else {
      // Muted inactive turns: subtle gray dot
      cells[rowIdx] = '\x1b[38;2;115;115;120m•\x1b[0m';
    }
  }

  return { cells, layout: { dotRows, rowToTurn } };
}

/**
 * Render the Floating Turn Preview Card popover.
 * Exactly matches the UX/UI in Screen Recording 2026-10-30 at 02.42.17:
 * - Rounded elevated box (╭─╮ / ╰─╯) with dark translucent background
 * - Line 1-2: User prompt in bold primary white
 * - Line 3-4: Assistant preview in muted secondary text
 * - Footer: Left 'X of Y', Right timestamp
 */
export function renderTurnPreviewCard(turn: SessionTurn, maxCardWidth = 50): string[] {
  const cardWidth = Math.max(38, Math.min(60, maxCardWidth));
  const innerWidth = cardWidth - 4; // 2 border chars + 2 padding chars

  const cardBg = '\x1b[48;2;28;28;32m';
  const borderStyle = `${cardBg}\x1b[38;2;75;75;82m`;
  const reset = '\x1b[0m';

  // Format header: User Prompt (bold primary)
  const rawPrompt = turn.userPrompt || 'User request';
  const promptLines = wrapBlock(rawPrompt, innerWidth).slice(0, 2);
  if (promptLines.length === 2 && promptLines[1]) {
    promptLines[1] = truncate(promptLines[1], innerWidth - 3, '...');
  }

  // Format body: Assistant Summary (muted secondary)
  let bodyLines: string[] = [];
  if (turn.assistantSummary) {
    bodyLines = wrapBlock(turn.assistantSummary, innerWidth).slice(0, 3);
    if (bodyLines.length === 3 && bodyLines[2]) {
      bodyLines[2] = truncate(bodyLines[2], innerWidth - 3, '...');
    }
  }

  // Format footer: 'X of Y' on left, timestamp on right
  const counterText = `${turn.turnIndex} of ${turn.totalTurns}`;
  const dateText = turn.formattedDate;
  const footerSpace = Math.max(2, innerWidth - counterText.length - dateText.length);
  const footerLine = `${counterText}${' '.repeat(footerSpace)}${dateText}`;

  // Assemble rows
  const rows: string[] = [];
  const topBorder = `${borderStyle}╭${'─'.repeat(cardWidth - 2)}╮${reset}`;
  const bottomBorder = `${borderStyle}╰${'─'.repeat(cardWidth - 2)}╯${reset}`;

  rows.push(topBorder);

  // User prompt rows
  for (const pl of promptLines) {
    const padded = padEnd(pl, innerWidth);
    rows.push(`${borderStyle}│${cardBg} \x1b[1m\x1b[38;2;240;240;245m${padded}${borderStyle} │${reset}`);
  }

  // Body rows if present
  if (bodyLines.length > 0) {
    rows.push(`${borderStyle}│${cardBg}${' '.repeat(innerWidth + 2)}${borderStyle}│${reset}`);
    for (const bl of bodyLines) {
      const padded = padEnd(bl, innerWidth);
      rows.push(`${borderStyle}│${cardBg} \x1b[38;2;160;160;168m${padded}${borderStyle} │${reset}`);
    }
  }

  // Empty spacing before footer
  rows.push(`${borderStyle}│${cardBg}${' '.repeat(innerWidth + 2)}${borderStyle}│${reset}`);

  // Footer row
  const paddedFooter = padEnd(footerLine, innerWidth);
  rows.push(`${borderStyle}│${cardBg} \x1b[38;2;125;125;132m${paddedFooter}${borderStyle} │${reset}`);

  rows.push(bottomBorder);
  return rows;
}

/**
 * Overlay the floating preview card onto viewport rows at a specific anchorY.
 */
export function overlayTurnPreviewCard(
  viewportRows: string[],
  cardRows: string[],
  anchorY: number,
  railX: number,
  screenWidth: number
): string[] {
  if (cardRows.length === 0 || viewportRows.length === 0) return viewportRows;

  const cardWidth = visibleWidth(cardRows[0] || '');
  // Clamp card placement horizontally: preferably to the left of the rail, or to the right
  let x = railX - cardWidth - 1;
  if (x < 0 || (railX <= 4 && railX + 2 + cardWidth <= screenWidth)) {
    x = Math.max(0, Math.min(screenWidth - cardWidth - 1, railX + 2));
  }

  // Center vertically around anchorY
  const startY = Math.max(
    0,
    Math.min(viewportRows.length - cardRows.length, anchorY - Math.floor(cardRows.length / 2))
  );

  const out = viewportRows.slice();
  for (let i = 0; i < cardRows.length; i++) {
    const targetY = startY + i;
    if (targetY >= out.length) break;
    const baseRow = out[targetY] || '';
    const cardRow = cardRows[i] || '';

    // Composite cardRow onto baseRow at column x
    const beforePart = padEnd(truncate(baseRow, x, ''), x);
    const afterPart = baseRow.length > x + cardWidth ? baseRow.slice(x + cardWidth) : '';
    out[targetY] = `${beforePart}${cardRow}${afterPart}`;
  }

  return out;
}

export function isMouseMotion(sequence: string | undefined): boolean {
  const code = Number(/^\x1b\[<(\d+);/.exec(sequence || '')?.[1]);
  return Number.isFinite(code) && (code & 32) !== 0;
}

/**
 * Handle mouse interaction (hover and click) for the Turn Rail.
 */
export function handleTurnRailMouse(
  event: { mouse?: { x: number; y: number; button?: number; pressed?: boolean }; sequence?: string },
  surface: any,
  host: any
): boolean {
  if (!surface?.turnRailLayout || !event.mouse) return false;
  const layout = surface.turnRailLayout;
  const mouseX = event.mouse.x;
  const mouseY = event.mouse.y;
  const stageTop = layout.stageTop ?? 0;
  const relY = mouseY - stageTop;

  const isRail = mouseX >= layout.railX - 1 && mouseX <= layout.railX + 1;
  if (!isRail || relY < 0 || relY >= layout.viewportHeight) {
    if (surface.hoveredTurnIndex !== null && surface.hoveredTurnIndex !== undefined) {
      surface.hoveredTurnIndex = null;
      surface.hoveredTurnAnchorY = null;
      if (typeof host?.scheduleDraw === 'function') host.scheduleDraw();
      else if (typeof host?.draw === 'function') host.draw();
    }
    return false;
  }

  const turnNum = layout.rowToTurn?.get(relY);
  if (turnNum) {
    if (isMouseMotion(event.sequence)) {
      if (surface.hoveredTurnIndex !== turnNum) {
        surface.hoveredTurnIndex = turnNum;
        surface.hoveredTurnAnchorY = relY;
        if (typeof host?.scheduleDraw === 'function') host.scheduleDraw();
        else if (typeof host?.draw === 'function') host.draw();
      }
      return true;
    }
    if (event.mouse.button === 0 && event.mouse.pressed) {
      const turn = layout.turns?.find((t: SessionTurn) => t.turnIndex === turnNum);
      if (turn && surface.viewport && typeof surface.viewport.scrollTo === 'function') {
        surface.viewport.scrollTo(turn.startRow);
        surface.hoveredTurnIndex = null;
        surface.hoveredTurnAnchorY = null;
        if (typeof host?.draw === 'function') host.draw();
        else if (typeof host?.scheduleDraw === 'function') host.scheduleDraw();
        return true;
      }
    }
  } else if (surface.hoveredTurnIndex !== null && surface.hoveredTurnIndex !== undefined) {
    surface.hoveredTurnIndex = null;
    surface.hoveredTurnAnchorY = null;
    if (typeof host?.scheduleDraw === 'function') host.scheduleDraw();
    else if (typeof host?.draw === 'function') host.draw();
  }

  return false;
}
