// Local terminal reports for usage, context, checkpoints and status.

import { TOOL_DEFINITIONS } from './tools/registry.js';
import { CORE_TOOLS, PACKS, PACK_PLAYBOOKS } from './toolPacks.js';
import { resolveCharPool } from './contextManager.js';
import { TokenTracker } from './tokenTracker.js';
import { loadConfig } from './config.js';
import { listSpills, getOutputDir } from './outputStore.js';
import { listGroups, undoLast, undoTask, undoStep, getStoreStats } from './checkpoints.js';
import { panel } from './tui/block.js';
import { terminalWidth, readableWidth } from './tui/theme.js';

// The same divisor scripts/measure_context.js uses, so the CLI and the dev
// harness never disagree about what a token costs.
const APPROX_CHARS_PER_TOKEN = 4;

function tokensOf(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.round(text.length / APPROX_CHARS_PER_TOKEN);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function formatAge(ts) {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function schemaTokens(names) {
  const set = new Set(names);
  return TOOL_DEFINITIONS
    .filter(tool => set.has(tool.name))
    .reduce((sum, tool) => sum + tokensOf(tool), 0);
}

// ---------------------------------------------------------------------------
// Context accounting
// ---------------------------------------------------------------------------

export function buildContextReport() {
  const config = loadConfig();
  const tier = config.tier || 'premium';
  const charPool = resolveCharPool(tier, config.contextCharPool);

  const packs = Object.entries(PACKS).map(([name, tools]) => ({
    name,
    tools: tools.length,
    tokens: schemaTokens(tools),
    playbookTokens: PACK_PLAYBOOKS[name] ? tokensOf(PACK_PLAYBOOKS[name]) : 0
  }));

  const spills = listSpills(1000);

  return {
    tier,
    provider: config.provider || 'default',
    model: config.model || 'default',
    charPool,
    approxTokenPool: Math.round(charPool / APPROX_CHARS_PER_TOKEN),
    core: { tools: CORE_TOOLS.length, tokens: schemaTokens(CORE_TOOLS) },
    packs,
    allTools: TOOL_DEFINITIONS.length,
    allToolTokens: TOOL_DEFINITIONS.reduce((sum, tool) => sum + tokensOf(tool), 0),
    spill: {
      dir: getOutputDir(),
      files: spills.length,
      bytes: spills.reduce((sum, item) => sum + item.bytes, 0),
      newest: spills.length > 0 ? new Date(spills[0].modified).toISOString() : null
    }
  };
}

export function buildContextText() {
  const report = buildContextReport();
  const lines = [];

  lines.push('Context accounting');
  lines.push(`  Provider / model : ${report.provider} / ${report.model}`);
  lines.push(`  Tier             : ${report.tier}`);
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
  lines.push(`  Directory        : ${report.spill.dir}`);
  lines.push(`  Saved outputs    : ${report.spill.files} file(s), ${formatBytes(report.spill.bytes)}`);
  lines.push('  These hold the full text of results too large for the window, so the');
  lines.push('  agent can read them back instead of re-running the tool. Kept 7 days.');

  return lines.join('\n');
}

export function printContextReport() {
  printReport(buildContextText(), { title: 'Context accounting' });
}

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

export async function buildUsageText() {
  const tracker = new TokenTracker();
  const usage = await tracker.getReportedUsage();
  const config = loadConfig();
  const budget = config.tokenBudget || {};
  const lines = [];

  lines.push('Token usage (BYOK — billed by your provider, not by Causyne)');
  lines.push(`  Provider / model : ${config.provider || 'default'} / ${config.model || 'default'}`);
  lines.push(`  This task        : ${formatNumber(usage.taskTokens)} tokens   $${Number(usage.taskCostUsd || 0).toFixed(4)}`);
  lines.push(`  Today            : ${formatNumber(usage.dailyTokens)} tokens   $${Number(usage.costUsd || 0).toFixed(4)}`);
  lines.push(`  Lifetime         : ${formatNumber(usage.lifetimeTokens)} tokens   $${Number(usage.lifetimeCostUsd || 0).toFixed(4)}`);

  if (budget.enabled) {
    const limit = budget.maxTokensPerDay || 0;
    const pct = limit > 0 ? ((usage.dailyTokens / limit) * 100).toFixed(1) : '0.0';
    lines.push(`  Daily budget     : ${formatNumber(limit)} tokens (${pct}% used)`);
    if (budget.maxCostUsd) {
      lines.push(`  Cost ceiling     : $${Number(budget.maxCostUsd).toFixed(2)}${budget.hardStop ? ' (hard stop)' : ''}`);
    }
  } else {
    lines.push('  Daily budget     : disabled');
  }

  return lines.join('\n');
}

export async function printUsageReport() {
  printReport(await buildUsageText(), { title: 'Token usage' });
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

export function buildCheckpointsText(limit = 15) {
  const groups = listGroups(limit);
  const stats = getStoreStats();
  const lines = [];

  lines.push('Checkpoints');
  lines.push(`  Store: ${stats.dir}  (${stats.entries} entries, ${formatBytes(stats.bytes)})`);
  lines.push('');

  if (groups.length === 0) {
    lines.push('  No checkpoints recorded yet. They are captured automatically before');
    lines.push('  the agent writes, edits, moves or deletes a file.');
    return lines.join('\n');
  }

  for (const group of groups) {
    const label = group.taskId.startsWith('undo_') ? '  (undo restore point)' : '';
    lines.push(`  ${group.taskId}  ${formatAge(group.ts)}${label}`);
    if (group.prompt) lines.push(`    task     : ${group.prompt}`);
    lines.push(`    files    : ${group.fileEntries.length} change(s) checkpointed`);
    lines.push(`    history  : ${group.hasHistory ? 'snapshotted (undo rewinds the conversation too)' : 'not captured'}`);

    for (const tree of group.trees) {
      lines.push(tree.skipped
        ? `    tree     : ${tree.root} — SKIPPED (${tree.skipped})`
        : `    tree     : ${tree.root} — ${tree.fileCount} files, ${formatBytes(tree.totalBytes)}`);
    }
    for (const entry of group.fileEntries.slice(0, 6)) {
      const verb = entry.before === null ? 'created' : 'modified';
      lines.push(`      ${entry.tool.padEnd(10)} ${verb.padEnd(9)} ${entry.path}`);
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

export function printCheckpoints(limit = 15) {
  printReport(buildCheckpointsText(limit), { title: 'Checkpoints' });
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/**
 * Perform the requested rollback and hand back the RAW result.
 *
 * Split out of buildUndoText because there are now two consumers and a restore
 * must happen exactly once per request. Calling buildUndoText and then
 * buildUndoPayload for the same request would roll back twice — the second call
 * would "restore" the state the first call just wrote. So the dispatch lives
 * here, in one place, and each surface renders the single result it is given.
 */
function runUndo(taskId, options = {}) {
  const opts = { dryRun: options.dryRun, full: options.full };
  return options.step
    ? undoStep({ dryRun: options.dryRun })
    : (taskId ? undoTask(taskId, opts) : undoLast(opts));
}

export function buildUndoText(taskId, options = {}) {
  const result = runUndo(taskId, options);
  if (!result.ok) return { ok: false, text: `[UNDO] ${result.error}` };
  return renderUndo(result);
}

/** Render a completed undo result as the plain text both terminals expect. */
function renderUndo(result) {
  const lines = [];
  lines.push(`${result.dryRun ? 'Undo preview (nothing written)' : 'Undo'}${result.taskId ? `  —  task ${result.taskId}` : ''}`);
  lines.push('');

  if (result.results.length === 0) {
    // Distinguish "nothing was watched" from "nothing changed". They look the
    // same from here and mean opposite things: the first is a gap in coverage,
    // the second is a clean answer.
    const drifted = (result.drift || []).reduce((total, item) => total + item.files.length, 0);
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
  for (const item of result.results) {
    if (String(item.action).startsWith('FAILED')) failures++;
    lines.push(`  ${item.action}  ${item.path}`);
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

  for (const item of result.drift || []) {
    lines.push('');
    lines.push(`  ${item.files.length} file(s) under ${item.root} also changed during this task`);
    lines.push('  but were not announced by a tool (typically a terminal command):');
    for (const file of item.files.slice(0, 8)) lines.push(`    ${file}`);
    if (item.files.length > 8) lines.push(`    ... and ${item.files.length - 8} more`);
    lines.push('  Add --full to roll those back too (this also reverts edits you made');
    lines.push('  by hand while the task ran, so review the list first).');
  }

  for (const tree of result.skippedTrees || []) {
    lines.push('');
    lines.push(`  Note: the workspace tree at ${tree.root} was not snapshotted (${tree.reason}),`);
    lines.push('  so changes made there by terminal commands are not covered by this undo.');
  }

  if (!result.dryRun) {
    lines.push('');
    lines.push('  This undo was itself checkpointed — run `checkpoints` to reverse it.');
  }

  return { ok: failures === 0, text: lines.join('\n') };
}

export function printUndo(taskId, options = {}) {
  const { ok, text } = buildUndoText(taskId, options);
  printReport(text, { title: 'Undo' });
  return ok;
}

/** `3d 4h 12m` — uptime a human reads at a glance. */
export function formatUptime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
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
 *
 * @param {object} opts
 * @param {object|null} opts.loop    the live AgentLoop, for workspace scope
 */
export function buildStatusText({ loop = null } = {}) {
  const config = loadConfig();
  const lines = ['Status'];

  lines.push('  Runtime          : local desktop');

  lines.push(`  Provider / model : ${config.provider || 'default'} / ${config.model || 'default'}`);
  lines.push(`  Autonomy mode    : ${config.autonomyMode || 'C'}`);
  lines.push(`  Tier             : ${config.tier || 'premium'}`);

  if (loop && loop.sandbox) {
    const sandbox = loop.sandbox;
    lines.push(`  Workspace scope  : ${sandbox.grantAllAccess ? 'ALL ACCESS' : (sandbox.workspacePaths || []).join(', ')}`);
  }

  if (!config.apiKey && config.provider !== 'ollama') {
    lines.push('');
    lines.push('  No API key is set. Run `causyne config`.');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// One report, two renderings
//
// Same split the undo payloads already use: the builders above produce plain
// text, and this decides how it reaches the surface. A terminal gets a framed
// panel wrapped to a readable measure; a pipe gets the bytes and nothing else,
// because `causyne usage | grep` must not have to strip a box.
// ---------------------------------------------------------------------------

/** True when stdout is a terminal a panel would look right in. */
export function canDrawPanel() {
  return Boolean(process.stdout && process.stdout.isTTY);
}

/**
 * Render a report for whichever surface is listening.
 *
 * The panel is measured with readableWidth() rather than the full terminal:
 * these reports are prose-shaped, and a 220-column line loses the eye's return
 * sweep. Chrome follows the terminal, text does not.
 */
export function renderReport(text, { title = '', force = null } = {}) {
  const draw = force === null ? canDrawPanel() : force;
  if (!draw) return String(text);
  const width = Math.min(readableWidth() + 4, terminalWidth());
  const rows = String(text).split('\n');
  // The builder already put the report name on row 0; the panel title would say
  // it a second time.
  const body = title && rows[0] === title ? rows.slice(1) : rows;
  return panel(body, { width, title: title || undefined }).join('\n');
}

/** Print a report to stdout, framed when a terminal is watching. */
export function printReport(text, options = {}) {
  console.log('\n' + renderReport(text, options) + '\n');
}
