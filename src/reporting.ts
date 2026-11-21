// Local terminal reports for usage, context, checkpoints and status.

import { TOOL_DEFINITIONS } from './tools/registry.js';
import { CORE_TOOLS, PACKS, PACK_PLAYBOOKS } from './toolPacks.js';
import { resolveCharPool, resolveModelContextTokens } from './contextManager.js';
import { TokenTracker } from './tokenTracker.js';
import { loadConfig } from './config.js';
import { listSpills, getOutputDir } from './outputStore.js';
import { listGroups, undoLast, undoTask, undoStep, getStoreStats } from './checkpoints.js';
import { panel } from './tui/block.js';
import { safeDisplay } from './tui/text.js';
import { terminalWidth, readableWidth } from './tui/theme.js';
import { isAcpProvider } from './providers/acp.js';
import { isAntigravityProvider } from './providers/antigravity.js';

// The same divisor scripts/measure_context.js uses, so the CLI and the dev
// harness never disagree about what a token costs.
const APPROX_CHARS_PER_TOKEN = 4;

export interface ContextPackReport {
  name: string;
  tools: number;
  tokens: number;
  playbookTokens: number;
}

export interface ContextReport {
  tier: string;
  provider: string;
  model: string;
  charPool: number;
  approxTokenPool: number;
  core: { tools: number; tokens: number };
  packs: ContextPackReport[];
  allTools: number;
  allToolTokens: number;
  spill: {
    dir: string;
    files: number;
    bytes: number;
    newest: string | null;
  };
}

export interface UndoCommandOptions {
  step?: boolean | undefined;
  full?: boolean | undefined;
  dryRun?: boolean | undefined;
  workspaceRoot?: string | undefined;
}

export interface UndoRenderResult {
  ok: boolean;
  text: string;
}

export interface ReportRenderOptions {
  title?: string | undefined;
  force?: boolean | null | undefined;
}

function tokensOf(value: unknown): number {
  if (typeof value === 'string') return Math.round(value.length / APPROX_CHARS_PER_TOKEN);
  if (value == null) return 0;
  let text: string;
  try {
    text = JSON.stringify(value) ?? '';
  } catch {
    text = String(value);
  }
  return Math.round(text.length / APPROX_CHARS_PER_TOKEN);
}

function formatBytes(bytes: number): string {
  const safe = typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (safe < 1024) return `${Math.floor(safe)} B`;
  if (safe < 1024 * 1024) return `${(safe / 1024).toFixed(1)} KB`;
  return `${(safe / (1024 * 1024)).toFixed(1)} MB`;
}

function formatNumber(value: unknown): string {
  const n = Number(value);
  return (Number.isFinite(n) ? n : 0).toLocaleString('en-US');
}

function formatAge(ts: number): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return 'unknown';
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function schemaTokens(names: readonly string[]): number {
  const set = new Set(names);
  return (TOOL_DEFINITIONS as Array<{ name: string }>)
    .filter(tool => set.has(tool.name))
    .reduce((sum, tool) => sum + tokensOf(tool), 0);
}

// ---------------------------------------------------------------------------
// Context accounting
// ---------------------------------------------------------------------------

export function buildContextReport(): ContextReport {
  const config = loadConfig() || {};
  const tier = String(config.tier || 'premium');
  const provider = String(config.provider || 'default');
  const model = String(config.model || 'default');
  const overrideTokens = Number(config.contextTokens || config.maxContextTokens || 0) || undefined;
  const charPool = resolveCharPool(tier, config.contextCharPool, {
    provider,
    model,
    overrideTokens
  });

  const modelTokens = resolveModelContextTokens({
    provider,
    model,
    overrideTokens
  });

  const approxTokenPool = modelTokens > 0
    ? modelTokens
    : Math.round(charPool / APPROX_CHARS_PER_TOKEN);

  const playbooks = PACK_PLAYBOOKS as Record<string, unknown>;
  const packs: ContextPackReport[] = Object.entries(PACKS as Record<string, readonly string[]>).map(([name, tools]) => ({
    name,
    tools: tools.length,
    tokens: schemaTokens(tools),
    playbookTokens: Object.hasOwn(playbooks, name) && playbooks[name] ? tokensOf(playbooks[name]) : 0
  }));

  const spills = listSpills(1000);
  const newestSpill = spills[0];

  return {
    tier,
    provider,
    model,
    charPool,
    approxTokenPool,
    core: { tools: CORE_TOOLS.length, tokens: schemaTokens(CORE_TOOLS) },
    packs,
    allTools: TOOL_DEFINITIONS.length,
    allToolTokens: (TOOL_DEFINITIONS as unknown[]).reduce<number>((sum, tool) => sum + tokensOf(tool), 0),
    spill: {
      dir: getOutputDir(),
      files: spills.length,
      bytes: spills.reduce((sum, item) => sum + item.bytes, 0),
      newest: newestSpill && Number.isFinite(newestSpill.modified) ? new Date(newestSpill.modified).toISOString() : null
    }
  };
}

export function buildContextText(): string {
  const report = buildContextReport();
  const lines: string[] = [];

  lines.push('Context accounting');
  lines.push(`  Provider / model : ${safeDisplay(report.provider)} / ${safeDisplay(report.model)}`);
  lines.push(`  Tier             : ${safeDisplay(report.tier)}`);
  lines.push(`  Window pool      : ${formatNumber(report.charPool)} chars (~${formatNumber(report.approxTokenPool)} tokens)`);
  lines.push('');
  lines.push('Tool schemas in context');
  lines.push(`  core (every step): ${String(report.core.tools).padStart(3)} tools  ${String(formatNumber(report.core.tokens)).padStart(7)} tok`);
  for (const pack of report.packs) {
    const playbook = pack.playbookTokens > 0 ? `  + ${formatNumber(pack.playbookTokens)} tok playbook` : '';
    lines.push(`  ${pack.name.padEnd(16)}: ${String(pack.tools).padStart(3)} tools  ${String(formatNumber(pack.tokens)).padStart(7)} tok${playbook}`);
  }
  lines.push(`  ${'all'.padEnd(16)}: ${String(report.allTools).padStart(3)} tools  ${String(formatNumber(report.allToolTokens)).padStart(7)} tok  (only unlocked packs are ever sent)`);
  lines.push('');
  lines.push('Spilled tool output');
  lines.push(`  Directory        : ${safeDisplay(report.spill.dir)}`);
  lines.push(`  Saved outputs    : ${report.spill.files} file(s), ${formatBytes(report.spill.bytes)}`);
  lines.push('  These hold the full text of results too large for the window, so the');
  lines.push('  agent can read them back instead of re-running the tool. Kept 7 days.');

  return lines.join('\n');
}

export function printContextReport(): void {
  printReport(buildContextText(), { title: 'Context accounting' });
}

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

export async function buildUsageText(): Promise<string> {
  const tracker = new TokenTracker();
  const usage = (await tracker.getReportedUsage()) || {
    taskTokens: 0,
    taskCostUsd: 0,
    dailyTokens: 0,
    costUsd: 0,
    lifetimeTokens: 0,
    lifetimeCostUsd: 0
  };
  const config = loadConfig() || {};
  const safeUsd = (v: unknown, digits: number): string => {
    const n = Number(v);
    return (Number.isFinite(n) && n >= 0 ? n : 0).toFixed(digits);
  };
  const budget = (config.tokenBudget || {}) as Record<string, unknown>;
  const lines: string[] = [];

  const provider = String(config.provider || 'default');
  const isAgy = isAntigravityProvider(provider);
  const isAcp = isAcpProvider(provider);
  const billingNote = (isAgy || isAcp)
    ? '(Local CLI / ACP peer)'
    : '(BYOK — billed by your provider, not by Causyne)';

  lines.push(`Token usage ${billingNote}`);
  lines.push(`  Provider / model : ${safeDisplay(config.provider || 'default')} / ${safeDisplay(config.model || 'default')}`);
  lines.push(`  This task        : ${formatNumber(usage.taskTokens)} tokens   $${safeUsd(usage.taskCostUsd, 4)}`);
  lines.push(`  Today            : ${formatNumber(usage.dailyTokens)} tokens   $${safeUsd(usage.costUsd, 4)}`);
  lines.push(`  Lifetime         : ${formatNumber(usage.lifetimeTokens)} tokens   $${safeUsd(usage.lifetimeCostUsd, 4)}`);

  if (budget.enabled) {
    const limit = Number(budget.maxTokensPerDay || 0);
    const pct = Number.isFinite(limit) && limit > 0 ? ((Number(usage.dailyTokens || 0) / limit) * 100).toFixed(1) : '0.0';
    lines.push(`  Daily budget     : ${formatNumber(limit)} tokens (${pct}% used)`);
    if (budget.maxCostUsd) {
      lines.push(`  Cost ceiling     : $${safeUsd(budget.maxCostUsd, 2)}${budget.hardStop ? ' (hard stop)' : ''}`);
    }
  } else {
    lines.push('  Daily budget     : disabled');
  }

  return lines.join('\n');
}

export async function printUsageReport(): Promise<void> {
  printReport(await buildUsageText(), { title: 'Token usage' });
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

export function buildCheckpointsText(limit = 15): string {
  const safeLimit = typeof limit === 'number' && Number.isFinite(limit)
    ? Math.max(1, Math.min(500, Math.floor(limit)))
    : 15;
  const groups = listGroups(safeLimit);
  const stats = getStoreStats();
  const lines: string[] = [];

  lines.push('Checkpoints');
  lines.push(`  Store: ${safeDisplay(stats.dir)}  (${stats.entries} entries, ${formatBytes(stats.bytes)})`);
  lines.push('');

  if (groups.length === 0) {
    lines.push('  No checkpoints recorded yet. They are captured automatically before');
    lines.push('  the agent writes, edits, moves or deletes a file.');
    return lines.join('\n');
  }

  for (const group of groups) {
    const label = group.taskId.startsWith('undo_') ? '  (undo restore point)' : '';
    lines.push(`  ${safeDisplay(group.taskId)}  ${formatAge(group.ts)}${label}`);
    if (group.prompt) lines.push(`    task     : ${safeDisplay(group.prompt)}`);
    lines.push(`    files    : ${group.fileEntries.length} change(s) checkpointed`);
    lines.push(`    history  : ${group.hasHistory ? 'snapshotted (undo rewinds the conversation too)' : 'not captured'}`);

    for (const tree of group.trees) {
      lines.push(tree.skipped
        ? `    tree     : ${safeDisplay(tree.root)} — SKIPPED (${safeDisplay(tree.skipped)})`
        : `    tree     : ${safeDisplay(tree.root)} — ${tree.fileCount ?? 0} files, ${formatBytes(tree.totalBytes ?? 0)}`);
    }
    for (const entry of group.fileEntries.slice(0, 6)) {
      const verb = entry.before === null ? 'created' : 'modified';
      lines.push(`      ${safeDisplay(entry.tool).padEnd(10)} ${verb.padEnd(9)} ${safeDisplay(entry.path)}`);
    }
    if (group.fileEntries.length > 6) {
      lines.push(`      ... and ${group.fileEntries.length - 6} more`);
    }
    lines.push('');
  }

  lines.push('  Roll back with:  undo            (the last task)');
  lines.push('                   undo --step     (just the last file change)');
  lines.push('                   undo <taskId>   (a specific task)');
  lines.push('  Preview first:   undo --dry-run');

  return lines.join('\n');
}

export function printCheckpoints(limit = 15): void {
  printReport(buildCheckpointsText(limit), { title: 'Checkpoints' });
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

function runUndo(taskId: string | undefined, options?: UndoCommandOptions | null): any {
  const safeOpts: UndoCommandOptions = options && typeof options === 'object' ? options : {};
  const opts = { dryRun: safeOpts.dryRun, full: safeOpts.full, workspaceRoot: safeOpts.workspaceRoot };
  return safeOpts.step
    ? undoStep({ dryRun: safeOpts.dryRun, workspaceRoot: safeOpts.workspaceRoot })
    : (taskId ? undoTask(taskId, opts) : undoLast(opts));
}

export function buildUndoText(taskId?: string, options?: UndoCommandOptions | null): UndoRenderResult {
  const result = runUndo(taskId, options);
  if (!result || !result.ok) return { ok: false, text: `[UNDO] ${safeDisplay(result?.error || 'undo failed')}` };
  return renderUndo(result);
}

/** Render a completed undo result as the plain text both terminals expect. */
function renderUndo(result: any): UndoRenderResult {
  const lines: string[] = [];
  const entries = Array.isArray(result?.results) ? result.results : [];
  const driftItems = Array.isArray(result?.drift) ? result.drift : [];
  const skippedTrees = Array.isArray(result?.skippedTrees) ? result.skippedTrees : [];
  lines.push(`${result?.dryRun ? 'Undo preview (nothing written)' : 'Undo'}${result?.taskId ? `  —  task ${safeDisplay(result.taskId)}` : ''}`);
  lines.push('');

  if (entries.length === 0) {
    const drifted = driftItems.reduce((total: number, item: { files?: unknown[] }) => total + (Array.isArray(item?.files) ? item.files.length : 0), 0);
    if (drifted > 0) {
      lines.push('  No tool announced a file change, but the workspace tree did move —');
      lines.push('  see below. That is what a terminal command looks like to undo.');
    } else if ((result.skippedTrees || []).length > 0) {
      lines.push('  Nothing was checkpointed for this task: the workspace tree could not be');
      lines.push('  snapshotted, so changes made here are not covered.');
    } else {
      lines.push('  Nothing to roll back — this task changed no files.');
    }
  }

  let failures = 0;
  for (const item of entries) {
    if (String(item.action).startsWith('FAILED')) failures++;
    lines.push(`  ${safeDisplay(item.action)}  ${safeDisplay(item.path)}`);
  }

  if (!result.dryRun) {
    if (result.historyRestored) {
      lines.push('');
      lines.push('  Conversation rewound to the state it had when the task began.');
    } else if (result.historyAvailable) {
      lines.push('');
      lines.push('  Conversation could NOT be rewound — files and chat history may now disagree.');
    }
  }

  for (const item of driftItems) {
    lines.push('');
    lines.push(`  ${item.files.length} file(s) under ${safeDisplay(item.root)} also changed during this task`);
    lines.push('  but were not announced by a tool (typically a terminal command):');
    for (const file of item.files.slice(0, 8)) lines.push(`    ${safeDisplay(file)}`);
    if (item.files.length > 8) lines.push(`    ... and ${item.files.length - 8} more`);
    lines.push('  Add --full to roll those back too (this also reverts edits you made');
    lines.push('  by hand while the task ran, so review the list first).');
  }

  for (const tree of skippedTrees) {
    lines.push('');
    lines.push(`  Note: the workspace tree at ${safeDisplay(tree.root)} was not snapshotted (${safeDisplay(tree.reason)}),`);
    lines.push('  so changes made there by terminal commands are not covered by this undo.');
  }

  if (!result.dryRun) {
    lines.push('');
    lines.push('  This undo was itself checkpointed — run `checkpoints` to reverse it.');
  }

  return { ok: failures === 0, text: lines.join('\n') };
}

export function printUndo(taskId?: string, options: UndoCommandOptions = {}): boolean {
  const { ok, text } = buildUndoText(taskId, options);
  printReport(text, { title: 'Undo' });
  return ok;
}

/** `3d 4h 12m` — uptime a human reads at a glance. */
export function formatUptime(ms: number): string {
  const safeMs = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSeconds = Math.floor(safeMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Local runtime status.
 */
export function buildStatusText(options?: { loop?: any } | null): string {
  const loop = options && typeof options === 'object' ? options.loop ?? null : null;
  const config = loadConfig() || {};
  const liveConfig = loop?.config || {};
  const provider = String(liveConfig.provider || config.provider || 'default');
  const model = String(liveConfig.model || config.model || 'default');
  const autonomyMode = String(liveConfig.autonomyMode || config.autonomyMode || 'C');
  const tier = String(liveConfig.tier || config.tier || 'premium');
  const lines = ['Status'];

  lines.push('  Runtime          : local desktop');

  if (loop?.memoryManager?.sessionId) {
    lines.push(`  Session          : ${safeDisplay(loop.memoryManager.sessionId)}`);
  }
  lines.push(`  Provider / model : ${safeDisplay(provider)} / ${safeDisplay(model)}`);
  lines.push(`  Autonomy mode    : ${safeDisplay(autonomyMode)}`);
  lines.push(`  Tier             : ${safeDisplay(tier)}`);

  if (loop && loop.sandbox) {
    const sandbox = loop.sandbox;
    const scopeText = sandbox.grantAllAccess
      ? 'ALL ACCESS'
      : (Array.isArray(sandbox.workspacePaths) ? sandbox.workspacePaths.map((p: unknown) => safeDisplay(p)).join(', ') : '');
    lines.push(`  Workspace scope  : ${scopeText}`);
  }

  if (!liveConfig.apiKey && !config.apiKey && provider !== 'ollama' && !isAcpProvider(provider) && !isAntigravityProvider(provider)) {
    lines.push('');
    lines.push('  No API key is set. Run `causyne config`.');
  }

  return lines.join('\n');
}

/** True when stdout is a terminal a panel would look right in. */
export function canDrawPanel(): boolean {
  return Boolean(process.stdout && process.stdout.isTTY);
}

/**
 * Render a report for whichever surface is listening.
 */
export function renderReport(text: unknown, options?: ReportRenderOptions | null): string {
  const safeOpts: ReportRenderOptions = options && typeof options === 'object' ? options : {};
  const title = typeof safeOpts.title === 'string' ? safeOpts.title : '';
  const force = safeOpts.force === undefined ? null : safeOpts.force;
  const draw = force === null ? canDrawPanel() : Boolean(force);
  const textStr = text == null ? '' : String(text);
  if (!draw) return textStr;
  const rawWidth = Math.min(readableWidth() + 4, terminalWidth());
  const width = Number.isFinite(rawWidth) ? Math.max(20, Math.floor(rawWidth)) : 80;
  const rows = textStr.split('\n');
  const body = title && rows[0] === title ? rows.slice(1) : rows;
  return panel(body, title ? { width, title } : { width }).join('\n');
}

/** Print a report to stdout, framed when a terminal is watching. */
export function printReport(text: unknown, options: ReportRenderOptions = {}): void {
  console.log('\n' + renderReport(text, options) + '\n');
}
