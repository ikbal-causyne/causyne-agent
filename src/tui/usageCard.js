/**
 * Usage Card Banner: Docked status and token usage card rendered directly above the chatbox.
 * Displays real-time session usage, all-time lifetime usage, daily spend, and context capacity.
 */
// @ts-expect-error theme.js has no TypeScript declaration yet.
import { paint, fill, bold, dim, GLYPHS, HAS_COLOR } from './theme.js';
import { visibleWidth, padEnd, safeDisplay, truncate } from './text.js';
import { FRAME } from './overlay.js';
import { TokenTracker } from '../tokenTracker.js';
import { loadConfig } from '../config.js';
// @ts-expect-error reporting.js has no TypeScript declaration yet.
import { buildContextReport } from '../reporting.js';
import { isAntigravityProvider } from '../providers/antigravity.js';
import { isAcpProvider } from '../providers/acp.js';
import { resolveModelContextTokens } from '../contextManager.js';
function oneLineText(value) {
    return safeDisplay(value).replace(/\s+/g, ' ').trim();
}
function formatNumber(value) {
    const num = Number(value);
    return (Number.isFinite(num) ? Math.max(0, Math.round(num)) : 0).toLocaleString('en-US');
}
function formatCostEstimate(costUsd) {
    const num = Number(costUsd);
    return Number.isFinite(num) && num > 0 ? `  ${dim(`$${num.toFixed(4)} est`)}` : '';
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
    // The running agent can differ from saved settings after a model switch.
    const liveConfig = loop?.config || {};
    const provider = oneLineText(liveConfig.provider || config.provider || 'default') || 'default';
    const model = oneLineText(liveConfig.model || config.model || 'default') || 'default';
    const isAgy = isAntigravityProvider(provider);
    const isAcp = isAcpProvider(provider);
    const billingNote = (isAgy || isAcp)
        ? 'Local CLI / ACP peer'
        : 'BYOK (provider billed)';
    const finiteNonNeg = (value, fallback = 0) => {
        const n = Number(value);
        return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    // Context accounting
    const contextReport = buildContextReport();
    const override = liveConfig.contextTokens || liveConfig.maxContextTokens
        || config.contextTokens || config.maxContextTokens;
    const explicitLimit = Number.isFinite(Number(override)) && Number(override) > 0;
    // report() uses persisted settings and can describe a *different* model.
    // Resolve against the actual running provider/model; otherwise say inferred.
    const modelLimit = resolveModelContextTokens({
        provider, model, overrideTokens: explicitLimit ? Number(override) : 0
    });
    const poolTokens = Math.floor(finiteNonNeg(modelLimit, finiteNonNeg(contextReport?.approxTokenPool, 0)));
    // Measure active messages tokens
    let messageChars = 0;
    let messageCount = 0;
    let rawMessages = [];
    if (Array.isArray(loop?.messages)) {
        rawMessages = loop.messages;
    }
    else if (typeof loop?.memoryManager?.loadHistory === 'function') {
        try {
            const loaded = loop.memoryManager.loadHistory();
            if (Array.isArray(loaded))
                rawMessages = loaded;
        }
        catch {
            rawMessages = [];
        }
    }
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
    const coreToolTokens = Math.floor(finiteNonNeg(contextReport?.core?.tokens, 5000));
    const contextUsed = messageTokens + coreToolTokens;
    const contextPctLeft = poolTokens > 0
        ? Math.max(0, Math.min(100, Math.round(((poolTokens - contextUsed) / poolTokens) * 100))) : 0;
    // Budget
    const budget = config.tokenBudget || {};
    const budgetEnabled = Boolean(budget.enabled);
    const budgetLimitTokens = Math.floor(finiteNonNeg(budget.maxTokensPerDay, 0));
    const dailyTokens = finiteNonNeg(daily?.totalTokens, 0);
    const budgetPercentUsed = budgetLimitTokens > 0
        ? Math.round((dailyTokens / budgetLimitTokens) * 100)
        : 0;
    const rawCostCeiling = finiteNonNeg(budget.maxCostUsd, 0);
    const sessionId = oneLineText(loop?.memoryManager?.sessionId || 'default') || 'default';
    const sessionMetricsAvailable = Boolean(loop?.tokenTracker);
    // These counters are per tracker instance, not persisted across restarts.
    const sessionTokens = finiteNonNeg(tracker.sessionTokens, finiteNonNeg(reported?.sessionTokens, 0));
    const sessionCostUsd = finiteNonNeg(tracker.sessionCostUsd, finiteNonNeg(reported?.sessionCostUsd, 0));
    return {
        sessionId,
        sessionTurns: messageCount,
        sessionTokens,
        sessionCostUsd,
        dailyTokens,
        dailyCostUsd: finiteNonNeg(daily?.totalCostUsd, 0),
        lifetimeTokens: finiteNonNeg(cumulative?.totalTokens, 0),
        lifetimeCostUsd: finiteNonNeg(cumulative?.totalCostUsd, 0),
        lifetimeCalls: Math.floor(finiteNonNeg(cumulative?.totalCalls, 0)),
        contextUsedTokens: contextUsed,
        contextPoolTokens: poolTokens,
        contextPercentLeft: contextPctLeft,
        provider,
        model,
        billingNote,
        budgetEnabled,
        budgetLimitTokens,
        budgetCostCeilingUsd: rawCostCeiling > 0 ? rawCostCeiling : undefined,
        budgetPercentUsed,
        sessionMetricsAvailable,
        contextLimitSource: explicitLimit ? 'configured' : 'inferred',
        usageProvenance: 'Local tracker: provider reports, ACP text estimates and media equivalents can be mixed'
    };
}
/**
 * Render the usage card as an array of styled terminal rows, exactly matching `width`.
 */
export function renderUsageCardRows(data, width) {
  const safeWidth = Number.isFinite(width) ? Math.max(4, Math.floor(width)) : 80;
  const frameWidth = safeWidth; // Never paint outside the terminal's actual columns.
  const innerWidth = Math.max(0, frameWidth - 4);
  const edge = paint('accent', FRAME.v);
  const title = frameWidth >= 32 ? ` ${bold(paint('accent', 'Usage & Context'))} `
    : frameWidth >= 13 ? ' Usage ' : '';
  const hint = frameWidth >= 43 ? ` ${dim('esc close')} ` : '';
  const lineRoom = Math.max(0, frameWidth - 3 - visibleWidth(title) - visibleWidth(hint));
  const top = paint('accent', FRAME.tl + FRAME.h)
    + title + paint('accent', FRAME.h.repeat(lineRoom)) + hint + paint('accent', FRAME.tr);
  const rows = [fill('surface', top)];

  const labelWidth = innerWidth >= 60 ? 16 : 13;
  const addRow = (label, value) => {
    const name = dim(String(label).padEnd(labelWidth));
    const text = name + value;
    const clipped = visibleWidth(text) > innerWidth
      ? truncate(text, innerWidth, GLYPHS.ellipsis) : text;
    const padding = ' '.repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
    rows.push(fill('surface', `${edge} ${clipped}${padding} ${edge}`));
  };

  const session = oneLineText(data.sessionId || 'unknown') || 'unknown';
  const sessionName = truncate(session, Math.max(8, Math.floor(innerWidth / 2)), '…');
  addRow('Session/Chat', `${paint('ink', sessionName)}  ${dim(`(${formatNumber(data.sessionTurns)} messages)`)}`);
  // Model and provider occupy separate rows, rather than squeezing two long
  // identifiers into a single line where neither is readable.
  addRow('Active Model', paint('accent', oneLineText(data.model || 'unknown')));
  addRow('Provider', `${paint('ink', oneLineText(data.provider || 'unknown'))} ${dim(oneLineText(data.billingNote || ''))}`);

  const pool = Number.isFinite(data.contextPoolTokens) && data.contextPoolTokens > 0
    ? data.contextPoolTokens : 0;
  const estimatedUsed = formatNumber(data.contextUsedTokens);
  if (pool > 0) {
    const percent = Number.isFinite(data.contextPercentLeft)
      ? Math.max(0, Math.min(100, Math.round(data.contextPercentLeft))) : 0;
    const poolSource = data.contextLimitSource === 'configured' ? 'configured cap' : 'inferred cap';
    addRow('Context (est.)', `~${estimatedUsed} / ~${formatNumber(pool)} tokens  (~${percent}% left; ${poolSource})`);
  } else {
    addRow('Context (est.)', `~${estimatedUsed} tokens; model limit unknown`);
  }

  addRow('This Session', data.sessionMetricsAvailable === false
    ? dim('unavailable (no live tracker)')
    : `${bold(formatNumber(data.sessionTokens))} tracked tokens ${dim('(current process only)')}`);
  addRow('Today (local)', `${bold(formatNumber(data.dailyTokens))} tracked tokens ${dim('(calendar day)')}`);
  addRow('All-Time', `${bold(formatNumber(data.lifetimeTokens))} tracked tokens ${dim(`(${formatNumber(data.lifetimeCalls)} recorded events)`)}`);

  const totalEstimate = formatCostEstimate(data.lifetimeCostUsd).trim();
  const dailyEstimate = formatCostEstimate(data.dailyCostUsd).trim();
  addRow('Cost (estimate)', totalEstimate
    ? `${totalEstimate} all-time${dailyEstimate ? ` · ${dailyEstimate} today` : ''}`
    : dim('no positive local estimate recorded'));

  addRow('Data source', dim('Local tracker; not provider billing or exact token telemetry'));
  if (data.budgetEnabled && typeof data.budgetLimitTokens === 'number' && Number.isFinite(data.budgetLimitTokens) && data.budgetLimitTokens > 0) {
    const pct = typeof data.budgetPercentUsed === 'number' && Number.isFinite(data.budgetPercentUsed)
      ? Math.max(0, Math.round(data.budgetPercentUsed)) : 0;
    addRow('Daily budget', `${formatNumber(data.dailyTokens)} / ${formatNumber(data.budgetLimitTokens)} tracked (${pct}% used)`);
  }

  const bottom = paint('accent', FRAME.bl + FRAME.h.repeat(Math.max(0, frameWidth - 2)) + FRAME.br);
  rows.push(fill('surface', bottom));
  rows.push(''); // Keep the composer visually separate from the usage panel.
  return rows;
}
