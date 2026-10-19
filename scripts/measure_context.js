// Development-only context accounting harness.
//
// NOT shipped to npm — this file must stay out of the package.json "files"
// whitelist so development-only diagnostics cannot enter the package.
//
// Usage:
//   node scripts/measure_context.js "build me a python script to rename files"
//   node scripts/measure_context.js --suite
//   node scripts/measure_context.js --spill    (A1 tool-output spill accounting)

import { TOOL_DEFINITIONS } from '../src/tools/registry.js';
import {
  routePacks,
  resolveActiveTools,
  isGameIntent,
  isWebIntent,
  PACKS,
  PACK_NAMES,
  PACK_PLAYBOOKS,
  CORE_TOOLS
} from '../src/toolPacks.js';
import { analyzeTask, buildTaskBrief, packsFromShape } from '../src/taskShape.js';

const APPROX_CHARS_PER_TOKEN = 4;

function tokensOf(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.round(text.length / APPROX_CHARS_PER_TOKEN);
}

function toolTokens(definitions) {
  return definitions.reduce((sum, def) => sum + tokensOf(def), 0);
}

const BASELINE_TOOL_TOKENS = toolTokens(TOOL_DEFINITIONS);

function report(prompt) {
  const shape = analyzeTask(prompt, null);
  const order = [...new Set([...packsFromShape(shape), ...routePacks(prompt, null)])];
  const packs = new Set(order);
  const active = resolveActiveTools(TOOL_DEFINITIONS, packs, new Set(), order);

  const playbookTokens = [...packs]
    .map(p => PACK_PLAYBOOKS[p])
    .filter(Boolean)
    .reduce((sum, text) => sum + tokensOf(text), 0);

  const briefTokens = tokensOf(buildTaskBrief(shape, active.map(t => t.name)));
  const activeToolTokens = toolTokens(active);
  const saved = BASELINE_TOOL_TOKENS - activeToolTokens;
  const pct = ((saved / BASELINE_TOOL_TOKENS) * 100).toFixed(0);

  console.log(`\n"${prompt}"`);
  console.log(`  work type        : ${shape.archetype} (${shape.confidence} confidence)`);
  console.log(`  packs pre-warmed : ${order.join(', ') || '(none — core only)'}`);
  console.log(`  game intent      : ${isGameIntent(prompt)}`);
  console.log(`  web intent       : ${isWebIntent(prompt)}`);
  console.log(`  tools in context : ${active.length} / ${TOOL_DEFINITIONS.length}`);
  console.log(`  tool tokens      : ${activeToolTokens} (baseline ${BASELINE_TOOL_TOKENS}, saved ${saved} = ${pct}%)`);
  console.log(`  pack playbooks   : ${playbookTokens} tokens`);
  console.log(`  task brief       : ${briefTokens} tokens`);
}

function summary() {
  console.log('Capability pack inventory');
  console.log('─'.repeat(64));
  const core = TOOL_DEFINITIONS.filter(d => CORE_TOOLS.includes(d.name));
  console.log(`  core       ${String(core.length).padStart(3)} tools  ${String(toolTokens(core)).padStart(6)} tok  (always loaded)`);
  for (const name of PACK_NAMES) {
    const defs = TOOL_DEFINITIONS.filter(d => PACKS[name].includes(d.name));
    const playbook = PACK_PLAYBOOKS[name] ? tokensOf(PACK_PLAYBOOKS[name]) : 0;
    console.log(
      `  ${name.padEnd(10)} ${String(defs.length).padStart(3)} tools  ${String(toolTokens(defs)).padStart(6)} tok` +
      (playbook ? `  + ${playbook} tok playbook` : '')
    );
  }
  console.log('─'.repeat(64));
  console.log(`  TOTAL      ${String(TOOL_DEFINITIONS.length).padStart(3)} tools  ${String(BASELINE_TOOL_TOKENS).padStart(6)} tok\n`);

  // B1 — what a provider WITHOUT native schema deferral actually ships.
  // Anthropic holds deferred schemas server-side, so it keeps the full core for
  // free; the other ten providers pay for every byte of it on every request.
  const fullCore = resolveActiveTools(TOOL_DEFINITIONS, new Set(), new Set(), null, {});
  const lean = resolveActiveTools(TOOL_DEFINITIONS, new Set(), new Set(), null, { residentOnly: true });
  const fullTokens = toolTokens(fullCore);
  const leanTokens = toolTokens(lean);

  console.log('Resident toolset (providers without native tool-search deferral)');
  console.log('─'.repeat(64));
  console.log(`  full core        ${String(fullCore.length).padStart(3)} tools  ${String(fullTokens).padStart(6)} tok   (Anthropic — deferred server-side, free)`);
  console.log(`  resident only    ${String(lean.length).padStart(3)} tools  ${String(leanTokens).padStart(6)} tok   (everyone else)`);
  console.log(`  SAVED PER REQUEST                 ${String(fullTokens - leanTokens).padStart(6)} tok`);
  console.log(`  resident set     ${lean.map(d => d.name).join(', ')}`);
  console.log('─'.repeat(64) + '\n');
}

const SUITE = [
  'build me a python script to rename files',
  'buatkan aku quick script untuk backup folder',
  'trace the bug in my logger',
  'tolong buatkan requirements.txt',
  'list the files on my Desktop and tell me how many there are',
  'what is 2+2',
  'build me a landing page for my startup',
  'buatkan game platformer 2D',
  'build me a 3D racing game in godot',
  'generate a background music track for my video',
  'kill whatever is running on port 3000'
];

// ---------------------------------------------------------------------------
// A1 — tool-output spill accounting.
//
// Before A1 an oversized result was cut to MAX_RESULT_CHARS and the overflow was
// destroyed, so the model's only route to the missing bytes was to run the tool
// again. That re-run costs a second execution AND puts a second full-size
// payload through the window. This measures what the spill saves on the second
// look, which is where the old design paid twice.
// ---------------------------------------------------------------------------

const MAX_RESULT_CHARS = 32000; // mirrors src/agentLoop.js

function spillReport() {
  // A realistic oversized observation: a big build log or a wide file read.
  const sizes = [
    ['64 KB  (a long build log)', 64 * 1024],
    ['512 KB (a wide grep across a repo)', 512 * 1024],
    ['4 MB   (a full dependency tree dump)', 4 * 1024 * 1024]
  ];

  // Old behaviour: the model re-runs the tool. The result comes back and is cut
  // to the same cap again, so the window pays MAX_RESULT_CHARS a second time —
  // on top of re-executing the tool itself.
  const oldTokens = Math.round(MAX_RESULT_CHARS / APPROX_CHARS_PER_TOKEN);
  // New behaviour: a targeted fs_read of the line range the model actually
  // wants, out of the spill file.
  const targetedReadChars = 4000;
  const newTokens = Math.round(targetedReadChars / APPROX_CHARS_PER_TOKEN);
  const savedTokens = oldTokens - newTokens;
  const savedPct = ((savedTokens / oldTokens) * 100).toFixed(0);

  console.log('A1 — oversized tool result');
  console.log('─'.repeat(78));
  console.log('  Bytes that used to be UNRECOVERABLE (destroyed by truncation):');
  console.log('');
  console.log('  ' + 'payload'.padEnd(38) + 'kept in window'.padStart(16) + 'lost before A1'.padStart(18));
  for (const [label, bytes] of sizes) {
    const lost = bytes - MAX_RESULT_CHARS;
    console.log(
      '  ' + label.padEnd(38) +
      `${(MAX_RESULT_CHARS / 1024).toFixed(0)} KB`.padStart(16) +
      `${(lost / 1024).toFixed(0)} KB`.padStart(18)
    );
  }
  console.log('');
  console.log('  Those bytes now survive at ~/.causyne/outputs. Cost of the SECOND look:');
  console.log('');
  console.log(`    old (re-run the tool) : ${oldTokens} tok  + a full re-execution`);
  console.log(`    new (read the spill)  : ${newTokens} tok  + no re-execution`);
  console.log(`    saved                 : ${savedTokens} tok per recovery (${savedPct}%)`);
  console.log('─'.repeat(78));
  console.log('  The token figure understates it: the old path also re-EXECUTED the tool');
  console.log('  (a shell command, a fetch, a full directory walk). The spill path does not.');
  console.log('');
}

const arg = process.argv[2];

if (arg === '--spill') {
  spillReport();
} else {
  summary();
  if (!arg || arg === '--suite') {
    for (const prompt of SUITE) report(prompt);
  } else {
    report(arg);
  }
  console.log('');
}
