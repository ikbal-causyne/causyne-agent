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
import { buildContextReport } from '../reporting.js';
import { isAntigravityProvider } from '../providers/antigravity.js';
import { isAcpProvider } from '../providers/acp.js';
import { resolveModelContextTokens } from '../contextManager.js';

export interface UsageCardData {
  sessionId: string;
  sessionTurns: number;
  sessionTokens: number;
  sessionCostUsd: number;
  dailyTokens: number;
  dailyCostUsd: number;
  lifetimeTokens: number;
  lifetimeCostUsd: number;
  lifetimeCalls: number;
  contextUsedTokens: number;
  contextPoolTokens: number;
  contextPercentLeft: number;
  provider: string;
  model: string;
  billingNote: string;
  budgetEnabled: boolean;
  budgetLimitTokens?: number | undefined;
  budgetCostCeilingUsd?: number | undefined;
  budgetPercentUsed?: number | undefined;
  /** All accounting is local; session counters require an active loop. */
  sessionMetricsAvailable?: boolean;
  /** A context ratio derived from text length and configured/assumed model window. */
  contextLimitSource?: 'configured' | 'inferred';
  /** Local history mixes provider token telemetry, ACP text estimates and media equivalents. */
  usageProvenance?: string;
}

function oneLineText(value: unknown): string {
  return safeDisplay(value).replace(/\s+/g, ' ').trim();
}

function formatNumber(value: number | undefined | null): string {
  const num = Number(value);
  return (Number.isFinite(num) ? Math.max(0, Math.round(num)) : 0).toLocaleString('en-US');
}

function formatCostEstimate(costUsd: number): string {
  const num = Number(costUsd);
  return Number.isFinite(num) && num > 0 ? `  ${dim(`$${num.toFixed(4)} est`)}` : '';
}

/**
 * Render a visual progress bar for context capacity or token budget.
 */
export function renderProgressBar(percent: number, barLength: number = 24, invertColors: boolean = false): string {
  const safePercent = Number.isFinite(percent) ? percent : 0;
  const safeLength = Number.isFinite(barLength) ? Math.max(1, Math.floor(barLength)) : 24;
  const clamped = Math.max(0, Math.min(100, Math.round(safePercent)));
  const filledChars = Math.max(0, Math.min(safeLength, Math.round((clamped / 100) * safeLength)));
  const emptyChars = Math.max(0, safeLength - filledChars);

  let role: string;
  if (!invertColors) {
    // Standard: higher percentage is good (e.g. % context remaining)
    role = clamped >= 40 ? 'success' : (clamped >= 20 ? 'warn' : 'danger');
  } else {
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
export async function collectUsageCardData(loop?: any): Promise<UsageCardData> {
  const tracker = loop?.tokenTracker && typeof loop.tokenTracker.getReportedUsage === 'function'
    ? loop.tokenTracker
    : new TokenTracker();

  const reported = await tracker.getReportedUsage();
  const cumulative = await tracker.getCumulativeUsage();
  const daily = await tracker.getDailyUsage();
  const config = loadConfig() as Record<string, any>;

  // The running agent can differ from saved settings after a model switch.
  const liveConfig = loop?.config || {};
  const provider = oneLineText(liveConfig.provider || config.provider || 'default') || 'default';
  const model = oneLineText(liveConfig.model || config.model || 'default') || 'default';
  const isAgy = isAntigravityProvider(provider);
  const isAcp = isAcpProvider(provider);
  const billingNote = (isAgy || isAcp)
    ? 'Local CLI / ACP peer'
    : 'BYOK (provider billed)';

  const finiteNonNeg = (value: unknown, fallback = 0): number => {
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
  const liveLimitChars = finiteNonNeg(loop?._contextLimitChars, 0);
  const liveLimitTokens = liveLimitChars > 0 ? Math.round(liveLimitChars / 4) : 0;
  const poolTokens = Math.floor(
    modelLimit > 0
      ? finiteNonNeg(modelLimit, 0)
      : (liveLimitTokens > 0 ? liveLimitTokens : finiteNonNeg(contextReport?.approxTokenPool, 0))
  );

  // Measure active messages tokens
  let messageChars = 0;
  let messageCount = 0;
  let rawMessages: unknown[] = [];
  if (Array.isArray(loop?.messages)) {
    rawMessages = loop.messages;
  } else if (typeof loop?.memoryManager?.loadHistory === 'function') {
    try {
      const loaded = loop.memoryManager.loadHistory();
      if (Array.isArray(loaded)) rawMessages = loaded;
    } catch {
      rawMessages = [];
    }
  }
  if (Array.isArray(rawMessages)) {
    messageCount = rawMessages.length;
    for (const msg of rawMessages as Array<Record<string, any>>) {
      if (typeof msg?.content === 'string') {
        messageChars += msg.content.length;
      } else if (Array.isArray(msg?.content)) {
        for (const part of msg.content) {
          if (typeof part === 'string') messageChars += part.length;
          else if (part?.text) messageChars += String(part.text).length;
        }
      }
    }
  }

  const messageTokens = Math.round(messageChars / 4);
  const coreToolTokens = Math.floor(finiteNonNeg(contextReport?.core?.tokens, 5000));
  const liveContextChars = finiteNonNeg(loop?._contextChars, 0);
  const liveContextTokens = liveContextChars > 0 ? Math.round(liveContextChars / 4) : 0;
  const contextUsed = liveContextTokens > 0
    ? Math.max(liveContextTokens, messageTokens)
    : (messageTokens + coreToolTokens);
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

interface FramedCardOptions {
  title: string;
  footer?: string;
  labelWidth?: number;
}

function buildFramedCardRows(
  width: number,
  options: FramedCardOptions,
  populate: (addRow: (label: string, value: string) => void, addLine: (line: string) => void, ctx: { innerWidth: number; labelWidth: number }) => void
): string[] {
  const safeWidth = Number.isFinite(width) ? Math.max(4, Math.floor(width)) : 80;
  const frameWidth = safeWidth; // Never paint outside the terminal's actual columns.
  const innerWidth = Math.max(0, frameWidth - 4);
  const edge = paint('accent', FRAME.v);
  const cleanTitle = oneLineText(options.title);
  const title = frameWidth >= 32 ? ` ${bold(paint('accent', cleanTitle))} `
    : frameWidth >= 13 ? ` ${cleanTitle.split(/\s+/)[0] || cleanTitle} ` : '';
  const footerText = oneLineText(options.footer || 'esc close');
  const hint = frameWidth >= 43 && footerText ? ` ${dim(footerText)} ` : '';
  const lineRoom = Math.max(0, frameWidth - 3 - visibleWidth(title) - visibleWidth(hint));
  const top = paint('accent', FRAME.tl + FRAME.h)
    + title + paint('accent', FRAME.h.repeat(lineRoom)) + hint + paint('accent', FRAME.tr);
  const rows = [fill('surface', top)];

  const labelWidth = options.labelWidth ?? (innerWidth >= 60 ? 16 : 13);
  const pushInnerRow = (text: string): void => {
    const clipped = visibleWidth(text) > innerWidth
      ? truncate(text, innerWidth, GLYPHS.ellipsis) : text;
    const padding = ' '.repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
    rows.push(fill('surface', `${edge} ${clipped}${padding} ${edge}`));
  };
  const addRow = (label: string, value: string): void => {
    const name = dim(String(label).padEnd(labelWidth));
    pushInnerRow(name + value);
  };

  populate(addRow, pushInnerRow, { innerWidth, labelWidth });

  const bottom = paint('accent', FRAME.bl + FRAME.h.repeat(Math.max(0, frameWidth - 2)) + FRAME.br);
  rows.push(fill('surface', bottom));
  rows.push(''); // Keep the composer visually separate from the pinned panel.
  return rows;
}

/**
 * Render the usage card as an array of styled terminal rows, exactly matching `width`.
 */
export function renderUsageCardRows(data: UsageCardData, width: number): string[] {
  return buildFramedCardRows(width, { title: 'Usage & Context', footer: 'esc close' }, (addRow, _addLine, { innerWidth, labelWidth }) => {
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
      const barRoom = Math.max(0, innerWidth - labelWidth - 13);
      if (barRoom >= 8) {
        const barWidth = Math.min(28, barRoom);
        const bar = renderProgressBar(percent, barWidth, false);
        addRow('Window left', `[${bar}] ${String(percent).padStart(3)}% left`);
      }
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
  });
}

/**
 * Render the pinned `/status` card matching the Usage card styling, plus live session/context meters when available.
 */
export function renderStatusCardRows(
  statusText: string,
  usageData: UsageCardData | null | undefined,
  width: number
): string[] {
  return buildFramedCardRows(width, { title: 'Status', footer: 'esc close' }, (addRow, addLine, { innerWidth, labelWidth }) => {
    const rawLines = String(statusText || '').split(/\r?\n/);
    if (rawLines[0]?.trim() === 'Status') rawLines.shift();
    let hasSessionLine = false;
    for (const rawLine of rawLines) {
      const trimmed = oneLineText(rawLine);
      if (!trimmed) continue;
      const sepIdx = trimmed.indexOf(':');
      if (sepIdx > 0 && sepIdx <= 20) {
        const key = trimmed.slice(0, sepIdx).trim();
        const val = trimmed.slice(sepIdx + 1).trim();
        if (key.toLowerCase() === 'session') hasSessionLine = true;
        const coloredVal = key.toLowerCase().includes('provider')
          ? paint('accent', val)
          : paint('ink', val);
        addRow(key, coloredVal);
      } else {
        addLine(dim(trimmed));
      }
    }

    if (usageData) {
      if (!hasSessionLine) {
        const session = oneLineText(usageData.sessionId || 'unknown') || 'unknown';
        const sessionName = truncate(session, Math.max(8, Math.floor(innerWidth / 2)), '…');
        addRow('Session', `${paint('ink', sessionName)}  ${dim(`(${formatNumber(usageData.sessionTurns)} messages)`)}`);
      }
      const pool = Number.isFinite(usageData.contextPoolTokens) && usageData.contextPoolTokens > 0
        ? usageData.contextPoolTokens : 0;
      const used = formatNumber(usageData.contextUsedTokens);
      if (pool > 0) {
        const percent = Number.isFinite(usageData.contextPercentLeft)
          ? Math.max(0, Math.min(100, Math.round(usageData.contextPercentLeft))) : 0;
        const barRoom = Math.max(0, innerWidth - labelWidth - 13);
        if (barRoom >= 8) {
          const barWidth = Math.min(26, barRoom);
          const bar = renderProgressBar(percent, barWidth, false);
          addRow('Context left', `[${bar}] ${String(percent).padStart(3)}% left`);
        }
        addRow('Context tokens', `~${used} / ~${formatNumber(pool)} tokens`);
      } else {
        addRow('Context tokens', `~${used} tokens; model limit unknown`);
      }
      if (usageData.sessionMetricsAvailable !== false) {
        addRow('Tracked tokens', `${bold(formatNumber(usageData.sessionTokens))} session · ${bold(formatNumber(usageData.dailyTokens))} today`);
      }
    }
  });
}
