/**
 * Usage Card Banner: Docked status and token usage card rendered directly above the chatbox.
 * Displays real-time session usage, all-time lifetime usage, daily spend, and context capacity.
 */
// @ts-expect-error theme.js has no TypeScript declaration yet.
import { paint, fill, bold, dim, GLYPHS, HAS_COLOR } from './theme.js';
import { visibleWidth, padEnd, truncate } from './text.js';
import { FRAME } from './overlay.js';
import { TokenTracker } from '../tokenTracker.js';
import { loadConfig } from '../config.js';
// @ts-expect-error reporting.js has no TypeScript declaration yet.
import { buildContextReport } from '../reporting.js';
import { isAntigravityProvider } from '../providers/antigravity.js';
import { isAcpProvider } from '../providers/acp.js';
function formatNumber(value) {
    return Number(value || 0).toLocaleString('en-US');
}
/**
 * Render a visual progress bar for context capacity or token budget.
 */
export function renderProgressBar(percent, barLength = 24, invertColors = false) {
    const safePercent = Number.isFinite(percent) ? percent : 0;
    const safeLength = Number.isFinite(barLength) ? Math.max(1, Math.floor(barLength)) : 24;
    const clamped = Math.max(0, Math.min(100, Math.round(safePercent)));
    const filledChars = Math.max(0, Math.min(safeLength, Math.round((clamped / 100) * safeLength)));
    const emptyChars = Math.max(0, safeLength - filledChars);
    let role;
    if (!invertColors) {
        // Standard: higher percentage is good (e.g. % context remaining)
        role = clamped >= 40 ? 'success' : (clamped >= 20 ? 'warn' : 'danger');
    }
    else {
        // Inverted: higher percentage is bad (e.g. % budget consumed)
        role = clamped <= 60 ? 'success' : (clamped <= 85 ? 'warn' : 'danger');
    }
    const fillGlyph = GLYPHS.block || '█';
    const emptyGlyph = GLYPHS.shadeLight || '░';
    const filledPart = paint(role, fillGlyph.repeat(filledChars));
    const emptyPart = dim(emptyGlyph.repeat(emptyChars));
    return `${filledPart}${emptyPart}`;
}
/**
 * Gather live usage and context accounting data from the session and token store.
 */
export async function collectUsageCardData(loop) {
    const tracker = loop?.tokenTracker && typeof loop.tokenTracker.getReportedUsage === 'function'
        ? loop.tokenTracker
        : new TokenTracker();
    const reported = await tracker.getReportedUsage();
    const cumulative = await tracker.getCumulativeUsage();
    const daily = await tracker.getDailyUsage();
    const config = loadConfig();
    const provider = String(config.provider || 'default');
    const model = String(config.model || 'default');
    const isAgy = isAntigravityProvider(provider);
    const isAcp = isAcpProvider(provider);
    const billingNote = (isAgy || isAcp)
        ? 'Local CLI / ACP peer'
        : 'BYOK (provider billed)';
    // Context accounting
    const contextReport = buildContextReport();
    const poolTokens = Math.max(1, contextReport.approxTokenPool || 250000);
    // Measure active messages tokens
    let messageChars = 0;
    let messageCount = 0;
    const rawMessages = loop?.messages || (loop?.memoryManager ? loop.memoryManager.loadHistory() : []);
    if (Array.isArray(rawMessages)) {
        messageCount = rawMessages.length;
        for (const msg of rawMessages) {
            if (typeof msg?.content === 'string') {
                messageChars += msg.content.length;
            }
            else if (Array.isArray(msg?.content)) {
                for (const part of msg.content) {
                    if (typeof part === 'string')
                        messageChars += part.length;
                    else if (part?.text)
                        messageChars += String(part.text).length;
                }
            }
        }
    }
    const messageTokens = Math.round(messageChars / 4);
    const coreToolTokens = contextReport.core?.tokens || 5000;
    const contextUsed = messageTokens + coreToolTokens;
    const contextPctLeft = Math.max(0, Math.min(100, Math.round(((poolTokens - contextUsed) / poolTokens) * 100)));
    // Budget
    const budget = config.tokenBudget || {};
    const budgetEnabled = Boolean(budget.enabled);
    const budgetLimitTokens = Number(budget.maxTokensPerDay) || 0;
    const budgetPercentUsed = budgetLimitTokens > 0
        ? Math.round((daily.totalTokens / budgetLimitTokens) * 100)
        : 0;
    const sessionId = String(loop?.memoryManager?.sessionId || 'default');
    return {
        sessionId,
        sessionTurns: messageCount,
        sessionTokens: tracker.sessionTokens || tracker.taskTokens || 0,
        sessionCostUsd: tracker.sessionCostUsd || tracker.taskCostUsd || 0,
        dailyTokens: daily.totalTokens,
        dailyCostUsd: daily.totalCostUsd || 0,
        lifetimeTokens: cumulative.totalTokens,
        lifetimeCostUsd: cumulative.totalCostUsd || 0,
        lifetimeCalls: cumulative.totalCalls || 0,
        contextUsedTokens: contextUsed,
        contextPoolTokens: poolTokens,
        contextPercentLeft: contextPctLeft,
        provider,
        model,
        billingNote,
        budgetEnabled,
        budgetLimitTokens,
        budgetCostCeilingUsd: Number(budget.maxCostUsd) || undefined,
        budgetPercentUsed
    };
}
/**
 * Render the usage card as an array of styled terminal rows, exactly matching `width`.
 */
export function renderUsageCardRows(data, width) {
    const frameWidth = Math.max(40, width);
    const innerWidth = Math.max(20, frameWidth - 4); // border (1) + pad (1) on each side
    const borderRole = 'accent';
    const surfaceRole = 'surface';
    // Header row
    const title = ` ${bold(paint('accent', 'Usage & Context'))} `;
    const closeHint = ` ${dim('esc close')} `;
    const hLineLength = Math.max(0, frameWidth - 2 - visibleWidth(title) - visibleWidth(closeHint));
    const topBorder = paint(borderRole, FRAME.tl + FRAME.h)
        + title
        + paint(borderRole, FRAME.h.repeat(hLineLength))
        + closeHint
        + paint(borderRole, FRAME.tr);
    // Content lines inside card
    const lines = [];
    // 1. Session ID & Message count
    const shortSession = data.sessionId.length > 24
        ? `${data.sessionId.slice(0, 10)}…${data.sessionId.slice(-10)}`
        : data.sessionId;
    lines.push(`${dim('Session/Chat :')} ${paint('ink', shortSession)}  ${dim(`(${data.sessionTurns} messages)`)}`);
    // 2. Context Window & Progress bar
    const pBar = renderProgressBar(data.contextPercentLeft, 22, false);
    lines.push(`${dim('Context      :')} ${bold(`${data.contextPercentLeft}% left`)} ${dim(`(${formatNumber(data.contextUsedTokens)} used / ${formatNumber(data.contextPoolTokens)})`)}  ${pBar}`);
    // 3. This Session Usage
    const sessionSpend = data.sessionCostUsd > 0
        ? `  ${dim(`$${data.sessionCostUsd.toFixed(4)} est`)}`
        : '';
    lines.push(`${dim('This Session :')} ${bold(formatNumber(data.sessionTokens))} tokens${sessionSpend}`);
    // 4. Daily Usage (Today)
    const dailySpend = data.dailyCostUsd > 0
        ? `  ${dim(`$${data.dailyCostUsd.toFixed(4)} est`)}`
        : '';
    lines.push(`${dim('Today (24h)  :')} ${bold(formatNumber(data.dailyTokens))} tokens${dailySpend}`);
    // 5. All-Time / Lifetime Usage
    const lifeSpend = data.lifetimeCostUsd > 0
        ? `  ${dim(`$${data.lifetimeCostUsd.toFixed(4)} est`)}`
        : '';
    lines.push(`${dim('All-Time     :')} ${bold(formatNumber(data.lifetimeTokens))} tokens${lifeSpend}  ${dim(`(${formatNumber(data.lifetimeCalls)} calls)`)}`);
    // 6. Model & Provider
    lines.push(`${dim('Active Model :')} ${paint('accent', `${data.provider} / ${data.model}`)}  ${dim(`(${data.billingNote})`)}`);
    // 7. Optional Budget
    if (data.budgetEnabled && data.budgetLimitTokens) {
        const bBar = renderProgressBar(data.budgetPercentUsed || 0, 16, true);
        lines.push(`${dim('Daily Budget :')} ${formatNumber(data.dailyTokens)} / ${formatNumber(data.budgetLimitTokens)} tokens (${data.budgetPercentUsed}% used)  ${bBar}`);
    }
    // Construct boxed rows
    const edge = paint(borderRole, FRAME.v);
    const rows = [fill(surfaceRole, topBorder)];
    for (const line of lines) {
        const clipped = visibleWidth(line) > innerWidth ? truncate(line, innerWidth, GLYPHS.ellipsis) : line;
        const padding = ' '.repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
        rows.push(fill(surfaceRole, `${edge} ${clipped}${padding} ${edge}`));
    }
    // Bottom row
    const bottomBorder = paint(borderRole, FRAME.bl + FRAME.h.repeat(Math.max(0, frameWidth - 2)) + FRAME.br);
    rows.push(fill(surfaceRole, bottomBorder));
    // Add 1 blank row gap separating the usage card from the chatbox below
    rows.push('');
    return rows;
}
