import { truncate, visibleWidth, wrapBlock, stripAnsi, padEnd } from './text.js';
// @ts-expect-error untyped local TUI theme
import { paint, bold, dim, GLYPHS } from './theme.js';
export function formatTurnTimestamp(ts) {
    if (!ts || !Number.isFinite(ts))
        return '';
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
 * Fast O(N) check for whether user turns exist without flattening or rendering frames.
 */
export function hasSessionTurns(transcript) {
    if (!transcript || !Array.isArray(transcript.frames) || transcript.frames.length === 0) {
        return false;
    }
    return transcript.frames.some((f) => f && f.kind === 'user');
}
/**
 * Collect all user turns from transcript frames.
 */
export function collectSessionTurns(transcript, contentWidth = 80) {
    if (!transcript || !Array.isArray(transcript.frames) || transcript.frames.length === 0) {
        return [];
    }
    const flat = typeof transcript.flatten === 'function' ? transcript.flatten(contentWidth) : null;
    const markers = flat?.markers || [];
    const frames = transcript.frames;
    const userFrames = [];
    for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        if (f && f.kind === 'user') {
            userFrames.push({ frame: f, index: i });
        }
    }
    const totalTurns = userFrames.length;
    if (totalTurns === 0)
        return [];
    const turns = [];
    for (let k = 0; k < userFrames.length; k++) {
        const item = userFrames[k];
        if (!item)
            continue;
        const { frame, index } = item;
        const turnIndex = k + 1;
        const nextUserFrameIndex = k + 1 < userFrames.length ? userFrames[k + 1].index : frames.length;
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
            assistantSummary: formatPreviewCardMarkdown(assistantSummary),
            timestamp: frame.ts || Date.now(),
            formattedDate: formatTurnTimestamp(frame.ts || Date.now()),
            frameId: frame.id,
            startRow
        });
    }
    return turns;
}
/**
 * Resolve which turn is currently active based on viewport scroll position.
 */
export function resolveActiveTurnIndex(turns, scrollTop, viewportHeight = 20, isAtBottom = false) {
    if (!turns || turns.length === 0)
        return 0;
    if (isAtBottom) {
        return turns[turns.length - 1].turnIndex;
    }
    if (scrollTop <= 0) {
        return turns[0].turnIndex;
    }
    let active = turns[turns.length - 1].turnIndex;
    const targetRow = Math.max(0, scrollTop + Math.floor(viewportHeight / 3));
    for (let i = turns.length - 1; i >= 0; i--) {
        const t = turns[i];
        if (t.startRow <= targetRow) {
            active = t.turnIndex;
            break;
        }
    }
    return active;
}
/**
 * ANSI-safe column slicing: skips the first startCol visible columns while preserving active styles.
 */
export function sliceFromColumn(source, startCol) {
    let col = 0;
    let index = 0;
    let activeStyles = '';
    while (index < source.length) {
        if (source[index] === '\x1b') {
            const rest = source.slice(index);
            const match = rest.match(/^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/)
                || rest.match(/^\x1b\[[0-?]*[ -/]*[@-~]/)
                || rest.match(/^\x1b[@-Z\\-_]/);
            if (match) {
                if (col < startCol) {
                    if (match[0] === '\x1b[0m' || match[0] === '\x1b[m') {
                        activeStyles = '';
                    }
                    else if (match[0].startsWith('\x1b[')) {
                        activeStyles += match[0];
                    }
                }
                index += match[0].length;
                continue;
            }
        }
        if (col >= startCol) {
            const tail = source.slice(index);
            // Ensure any OSC 8 hyperlink opened inside `tail` is closed at the end of the slice
            let openOsc8Term = '';
            const osc8Re = /\x1b\]8;[^;]*;([^\x07\x1b]*)(\x07|\x1b\\)/g;
            let oscMatch;
            while ((oscMatch = osc8Re.exec(tail)) !== null) {
                const uri = oscMatch[1] ?? '';
                const term = oscMatch[2] ?? '\x1b\\';
                openOsc8Term = uri.length > 0 ? term : '';
            }
            return activeStyles + tail + (openOsc8Term ? `\x1b]8;;${openOsc8Term}` : '');
        }
        const code = source.codePointAt(index);
        if (code === undefined)
            break;
        const char = String.fromCodePoint(code);
        col += visibleWidth(char);
        index += char.length;
    }
    return '';
}
/**
 * Build the vertical column of turn rail cells.
 * Matches the canonical Turn Rail UX from Screen Recording 2026-10-30 at 02.42.17:
 * - Consecutive vertical pillar when turns fit within viewport height.
 * - Proportional scaling when turn count exceeds available height.
 */
export function buildTurnRailCells(turns, height, activeTurnIndex, hoveredTurnIndex) {
    const cells = new Array(Math.max(0, height)).fill(' ');
    const dotRows = new Map();
    const rowToTurn = new Map();
    if (turns.length === 0 || height <= 0) {
        return { cells, layout: { dotRows, rowToTurn } };
    }
    const count = turns.length;
    // Dense imported histories may contain hundreds of turns. Show a measured
    // set of quiet milestones, while always retaining active/hovered endpoints.
    // All turn objects are preserved for keyboard navigation and preview.
    const quietStep = count > Math.max(16, Math.floor(height / 2))
        ? Math.max(2, Math.ceil(count / Math.max(12, Math.floor(height / 3))))
        : 1;
    // If count fits comfortably, stack consecutive dots centered or upper-aligned
    const startRow = count <= height
        ? Math.max(0, Math.floor((height - count) / 3))
        : 0;
    for (let i = 0; i < count; i++) {
        const turn = turns[i];
        if (!turn)
            continue;
        const turnNum = turn.turnIndex;
        let rowIdx;
        if (count <= height) {
            rowIdx = startRow + i;
        }
        else {
            rowIdx = Math.round((i / (count - 1)) * (height - 1));
        }
        rowIdx = Math.max(0, Math.min(height - 1, rowIdx));
        dotRows.set(turnNum, rowIdx);
        const isHovered = hoveredTurnIndex === turnNum;
        const isActive = activeTurnIndex === turnNum;
        const showQuiet = quietStep === 1 || i === 0 || i === count - 1 || i % quietStep === 0;
        if (isHovered || isActive || showQuiet)
            rowToTurn.set(rowIdx, turnNum);
        if (isHovered) {
            // Hovered dot: bright silver highlighted circle
            cells[rowIdx] = '\x1b[1m\x1b[38;2;230;235;245m●\x1b[0m';
        }
        else if (isActive && !cells[rowIdx]?.includes('230;235;245m')) {
            // Active / current turn: bright white circle
            cells[rowIdx] = '\x1b[1m\x1b[38;2;250;250;250m●\x1b[0m';
        }
        else if (showQuiet && !cells[rowIdx]?.includes('●')) {
            // Muted inactive turns: sparse gray dot in long sessions
            cells[rowIdx] = '\x1b[38;2;115;115;120m•\x1b[0m';
        }
    }
    return { cells, layout: { dotRows, rowToTurn } };
}
/**
 * Render and clean markdown for display within the Floating Turn Preview Card.
 * Strips raw syntax markers (###, **, *, `, table delimiters) and renders
 * clean, readable, professional text without leaking markdown source code.
 */
export function formatPreviewCardMarkdown(raw) {
    if (!raw)
        return '';
    let text = String(raw);
    // Strip code block fences
    text = text.replace(/```[a-zA-Z0-9_-]*\n?/g, ' ');
    // Strip headings: ### Heading -> Heading
    text = text.replace(/(?:^|\n)\s*#{1,6}\s+/g, '\n');
    // Strip blockquotes: > quote -> quote
    text = text.replace(/(?:^|\n)\s*>\s?/g, '\n');
    // Strip horizontal rules: --- or ***
    text = text.replace(/(?:^|\n)\s*[-*_]{3,}\s*(?=\n|$)/g, '\n');
    // Strip table separator lines: | :--- | :--- |
    text = text.replace(/(?:^|\n)\s*\|?(\s*:?-+:?\s*\|)+\s*(?=\n|$)/g, '\n');
    // Convert table row pipes: | a | b | -> a · b
    text = text.replace(/(?:^|\n)\s*\|\s*(.+?)\s*\|\s*(?=\n|$)/g, (_m, content) => {
        return '\n' + content.split(/\s*\|\s*/).filter(Boolean).join(' · ');
    });
    // Convert list bullets: - item, * item -> • item
    text = text.replace(/(?:^|\n)\s*[-*+]\s+/g, '\n• ');
    // Convert numbered lists: 1. item -> 1. item
    text = text.replace(/(?:^|\n)\s*(\d+)\.\s+/g, '\n$1. ');
    // Strip links: [label](url) -> label
    text = text.replace(/\[([^\]\n]+)\]\([^\)\s]+\)/g, '$1');
    // Strip images: ![alt](url) -> alt
    text = text.replace(/!\[([^\]\n]*)\]\([^\)\s]+\)/g, '$1');
    // Strip inline code backticks: `code` -> code
    text = text.replace(/`([^`\n]+)`/g, '$1');
    // Format bold and italic: ***text***, **text**, *text*, ___text___, __text__, _text_
    text = text.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
    text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
    text = text.replace(/(?:^|[^*])\*([^*]+)\*(?!\*)/g, (m, inner) => m.startsWith('*') ? inner : `${m[0]}${inner}`);
    text = text.replace(/___([^_]+)___/g, '$1');
    text = text.replace(/__([^_]+)__/g, '$1');
    text = text.replace(/(?:^|[^_])_([^_]+)_(?!_)/g, (m, inner) => m.startsWith('_') ? inner : `${m[0]}${inner}`);
    // Strip strikethrough: ~~text~~ -> text
    text = text.replace(/~~([^~]+)~~/g, '$1');
    // Collapse multiple spaces/newlines cleanly into single space
    return text.replace(/\s+/g, ' ').trim();
}
/**
 * Render the Floating Turn Preview Card popover.
 * Exactly matches the UX/UI in Screen Recording 2026-10-30 at 02.42.17:
 * - Rounded elevated box (╭─╮ / ╰─╯) with dark translucent background
 * - Line 1-2: User prompt in bold primary white
 * - Line 3-4: Assistant preview in muted secondary text
 * - Footer: Left 'X of Y', Right timestamp
 */
export function renderTurnPreviewCard(turn, maxCardWidth = 50) {
    const cardWidth = Math.max(38, Math.min(60, maxCardWidth));
    const innerWidth = cardWidth - 4; // 2 border chars + 2 padding chars
    const cardBg = '\x1b[48;2;28;28;32m';
    const borderStyle = `${cardBg}\x1b[38;2;75;75;82m`;
    const reset = '\x1b[0m';
    // Format header: User Prompt (bold primary) rendered cleanly without raw markdown, strictly flush-left with hang: 0
    const rawPrompt = formatPreviewCardMarkdown(turn.userPrompt || 'User request');
    const promptLines = wrapBlock(rawPrompt, innerWidth, { hang: 0 }).slice(0, 2);
    if (promptLines.length === 2 && promptLines[1]) {
        promptLines[1] = truncate(promptLines[1], innerWidth - 3, '...');
    }
    // Format body: Assistant Summary (muted secondary) rendered cleanly without raw markdown, strictly flush-left with hang: 0
    let bodyLines = [];
    if (turn.assistantSummary) {
        const formattedSummary = formatPreviewCardMarkdown(turn.assistantSummary);
        bodyLines = wrapBlock(formattedSummary, innerWidth, { hang: 0 }).slice(0, 3);
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
    const rows = [];
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
export function overlayTurnPreviewCard(viewportRows, cardRows, anchorY, railX, screenWidth) {
    if (cardRows.length === 0 || viewportRows.length === 0)
        return viewportRows;
    const cardWidth = visibleWidth(cardRows[0] || '');
    // Clamp card placement horizontally: flush-left with transcript baseline at column 3
    const cardSpacing = 2; // railX + 2 gives x = 3, perfectly flush left with transcript content
    let x = railX - cardWidth - 1;
    if (x < 0 || (railX <= 4 && railX + cardSpacing + cardWidth <= screenWidth)) {
        x = Math.max(0, Math.min(screenWidth - cardWidth - 1, railX + cardSpacing));
    }
    // Center vertically around anchorY
    const startY = Math.max(0, Math.min(viewportRows.length - cardRows.length, anchorY - Math.floor(cardRows.length / 2)));
    const out = viewportRows.slice();
    for (let i = 0; i < cardRows.length; i++) {
        const targetY = startY + i;
        if (targetY >= out.length)
            break;
        const baseRow = out[targetY] || '';
        const cardRow = cardRows[i] || '';
        // Composite cardRow onto baseRow at column x.
        // To the left of the card, NEVER allow severed underlying characters (like '▸' or text) to leak!
        // Maintain a perfectly clean, flush, symmetrical margin:
        // Only preserve the rail dot (if present at railX) and whitespace padding up to column x.
        let beforePart = '';
        if (x <= 6 && railX <= 4) {
            const plainBase = stripAnsi(baseRow);
            const dotChar = plainBase[railX] || ' ';
            const isDot = dotChar === '●' || dotChar === '•' || dotChar === '·' || dotChar === '[' || dotChar === ']';
            let dotCell = ' ';
            if (isDot) {
                const sliceDot = sliceFromColumn(baseRow, railX);
                dotCell = sliceDot ? truncate(sliceDot, 1, '') : dotChar;
            }
            const leadingSpace = ' '.repeat(Math.max(0, railX));
            const trailingSpace = ' '.repeat(Math.max(0, x - railX - 1));
            beforePart = `${leadingSpace}${dotCell}${trailingSpace}`;
        }
        else {
            beforePart = padEnd(truncate(baseRow, x, ''), x);
        }
        let restOfRow = '';
        if (x <= 6) {
            // For left-placed turn cards, do not leave severed text tails sticking out
            const totalRowWidth = Math.max(screenWidth, visibleWidth(baseRow));
            const rightCell = sliceFromColumn(baseRow, totalRowWidth - 1);
            const rightCellWidth = visibleWidth(rightCell);
            const gap = Math.max(0, totalRowWidth - x - cardWidth - rightCellWidth);
            restOfRow = `${' '.repeat(gap)}${rightCell}`;
        }
        else {
            restOfRow = sliceFromColumn(baseRow, x + cardWidth);
        }
        out[targetY] = `${beforePart}${cardRow}${restOfRow}`;
    }
    return out;
}
export function isMouseMotion(sequence) {
    const code = Number(/^\x1b\[<(\d+);/.exec(sequence || '')?.[1]);
    return Number.isFinite(code) && (code & 32) !== 0;
}
/**
 * Handle mouse interaction (hover and click) for the Turn Rail.
 */
export function handleTurnRailMouse(event, surface, host) {
    if (!surface?.turnRailLayout || !event.mouse)
        return false;
    const layout = surface.turnRailLayout;
    const mouseX = event.mouse.x;
    const mouseY = event.mouse.y;
    const stageTop = layout.stageTop ?? 0;
    const relY = mouseY - stageTop;
    // Rail hit box: if railX <= 2, check columns 0..3 (left margin); otherwise check [railX - 1, railX + 2]
    const isRail = layout.railX <= 2
        ? (mouseX >= 0 && mouseX <= Math.max(3, layout.railX + 2))
        : (mouseX >= layout.railX - 1 && mouseX <= layout.railX + 2);
    // Check if currently showing a card and mouse is hovering over the card or bridge tunnel
    const hasActiveCard = surface.hoveredTurnIndex !== null && surface.hoveredTurnIndex !== undefined;
    let isCard = false;
    let isBridge = false;
    if (hasActiveCard) {
        const cardRect = layout.cardRect;
        if (cardRect && cardRect.turnIndex === surface.hoveredTurnIndex) {
            isCard = mouseX >= cardRect.x && mouseX < cardRect.x + cardRect.width &&
                relY >= cardRect.y && relY < cardRect.y + cardRect.height;
            isBridge = layout.railX <= 4 &&
                mouseX >= 0 && mouseX < cardRect.x &&
                relY >= cardRect.y && relY < cardRect.y + cardRect.height;
        }
        else {
            const cardWidth = 52;
            const cardX = layout.railX <= 4 ? layout.railX + 2 : Math.max(0, layout.railX - cardWidth - 1);
            const anchorY = surface.hoveredTurnAnchorY ?? Math.floor(layout.viewportHeight / 2);
            const cardHeight = 9;
            const cardStartY = Math.max(0, Math.min(layout.viewportHeight - cardHeight, anchorY - Math.floor(cardHeight / 2)));
            const cardEndY = cardStartY + cardHeight;
            isCard = mouseX >= cardX && mouseX < cardX + cardWidth &&
                relY >= cardStartY && relY < cardEndY;
            isBridge = layout.railX <= 4 &&
                mouseX >= 0 && mouseX < cardX &&
                relY >= cardStartY && relY < cardEndY;
        }
    }
    const inHoverZone = isRail || isCard || isBridge;
    if (!inHoverZone || relY < 0 || relY >= layout.viewportHeight) {
        surface.turnRailHoverSuppressed = false;
        if (surface.hoveredTurnIndex !== null && surface.hoveredTurnIndex !== undefined) {
            if (!surface._turnCardLeaveTimer) {
                surface._turnCardLeaveTimer = setTimeout(() => {
                    surface._turnCardLeaveTimer = null;
                    if (surface.hoveredTurnIndex !== null && surface.hoveredTurnIndex !== undefined) {
                        surface.hoveredTurnIndex = null;
                        surface.hoveredTurnAnchorY = null;
                        if (typeof host?.scheduleDraw === 'function')
                            host.scheduleDraw();
                        else if (typeof host?.draw === 'function')
                            host.draw();
                    }
                }, 120);
            }
        }
        return false;
    }
    // Inside hover zone - cancel any pending leave timer
    if (surface._turnCardLeaveTimer) {
        clearTimeout(surface._turnCardLeaveTimer);
        surface._turnCardLeaveTimer = null;
    }
    // If hover is temporarily suppressed after a click, swallow rail mouse events until suppression ends
    if (surface.turnRailHoverSuppressed) {
        return true;
    }
    // Rail takes precedence when mouse is on the rail track
    let turnNum = isRail ? layout.rowToTurn?.get(relY) : ((isCard || isBridge) ? surface.hoveredTurnIndex : undefined);
    let anchorY = relY;
    // If on rail and not an exact row hit, resolve closest dot within proximity
    if (!turnNum && isRail && layout.dotRows && layout.dotRows.size > 0) {
        let minDistance = Infinity;
        let closestTurn;
        let closestRow;
        for (const [tNum, row] of layout.dotRows.entries()) {
            const dist = Math.abs(relY - row);
            if (dist < minDistance) {
                minDistance = dist;
                closestTurn = tNum;
                closestRow = row;
            }
        }
        if (minDistance <= 1 && closestTurn !== undefined && closestRow !== undefined) {
            turnNum = closestTurn;
            anchorY = closestRow;
        }
    }
    if (turnNum) {
        if (isMouseMotion(event.sequence)) {
            // While a turn is streaming, a hover card would sit on top of live output
            // (thinking, code edits, tool frames). Clicking a dot still navigates.
            if (host?.busy) {
                if (surface.hoveredTurnIndex !== null && surface.hoveredTurnIndex !== undefined) {
                    surface.hoveredTurnIndex = null;
                    surface.hoveredTurnAnchorY = null;
                    if (typeof host?.scheduleDraw === 'function')
                        host.scheduleDraw();
                    else if (typeof host?.draw === 'function')
                        host.draw();
                }
                return true;
            }
            if (surface.hoveredTurnIndex !== turnNum) {
                surface.hoveredTurnIndex = turnNum;
                surface.hoveredTurnAnchorY = anchorY;
                if (typeof host?.scheduleDraw === 'function')
                    host.scheduleDraw();
                else if (typeof host?.draw === 'function')
                    host.draw();
            }
            return true;
        }
        if (event.mouse.button === 0 && event.mouse.pressed) {
            const turns = layout.turns || [];
            const turn = turns.find((t) => t.turnIndex === turnNum);
            const isLatestTurn = turnNum === turns.length || (turn && turns.length > 0 && turn.turnIndex === turns[turns.length - 1].turnIndex);
            if (isLatestTurn && surface.viewport && typeof surface.viewport.toBottom === 'function') {
                surface.viewport.toBottom();
            }
            else if (turn && surface.viewport && typeof surface.viewport.scrollTo === 'function') {
                surface.viewport.scrollTo(turn.startRow);
            }
            surface.activeTurnIndex = turnNum;
            // Immediately dismiss preview card and activate temporary suppression cooldown
            surface.hoveredTurnIndex = null;
            surface.hoveredTurnAnchorY = null;
            surface.turnRailHoverSuppressed = true;
            if (surface._turnRailSuppressTimer) {
                clearTimeout(surface._turnRailSuppressTimer);
            }
            surface._turnRailSuppressTimer = setTimeout(() => {
                surface.turnRailHoverSuppressed = false;
            }, 400);
            if (typeof host?.draw === 'function')
                host.draw();
            else if (typeof host?.scheduleDraw === 'function')
                host.scheduleDraw();
            return true;
        }
    }
    else if (surface.hoveredTurnIndex !== null && surface.hoveredTurnIndex !== undefined) {
        surface.hoveredTurnIndex = null;
        surface.hoveredTurnAnchorY = null;
        if (typeof host?.scheduleDraw === 'function')
            host.scheduleDraw();
        else if (typeof host?.draw === 'function')
            host.draw();
    }
    return false;
}
