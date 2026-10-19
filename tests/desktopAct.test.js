import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { desktopAct } from '../src/tools/desktopAct.js';
import { resolveChannel, channelATools } from '../src/appChannel.js';
import { Sandbox } from '../src/sandbox.js';
import { TOOL_DEFINITIONS, toolRegistry } from '../src/tools/registry.js';
import { PACKS } from '../src/toolPacks.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, '..', 'src', 'tools', 'desktopAct.js'), 'utf8');

// The file documents the ZM rules by naming them. Strip comments before
// asserting on code, or the test passes on its own documentation.
const executable = SOURCE
  .split('\n')
  .filter(line => {
    const t = line.trim();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  })
  .join('\n');

const act = (args) => desktopAct.execute(args);

// ---------------------------------------------------------------------------
// C4 — the channel router
// ---------------------------------------------------------------------------

test('app_channel: apps with a native tool resolve to Channel A and are blocked from pixels', () => {
  for (const [app, tool] of [
    ['Blender', 'blender_act'],
    ['DaVinci Resolve', 'resolve_act'],
    ['Godot', 'godot_act'],
    ['Palmier Pro', 'palmier_act'],
    ['Google Chrome', 'browser_act'],
    ['Safari', 'browser_act']
  ]) {
    const choice = resolveChannel(app);
    assert.equal(choice.channel, 'A', `${app} did not resolve to Channel A`);
    assert.equal(choice.tool, tool, `${app} resolved to ${choice.tool}, expected ${tool}`);
    assert.equal(choice.blocked, true, `${app} was not blocked from the pixel path`);
  }
});

test('app_channel: a terminal is never driven by pixels', () => {
  const choice = resolveChannel('iTerm');
  assert.equal(choice.blocked, true);
  assert.equal(choice.tool, 'sysRun');
  assert.match(choice.reason, /text interface/);
});

test('app_channel: an unknown app falls through to Channel C, not to a refusal', () => {
  // "I do not recognise this app" is exactly when the universal fallback is the
  // right answer. Blocking here would make the whole tool useless.
  const choice = resolveChannel('Notes');
  assert.equal(choice.channel, 'C');
  assert.equal(choice.blocked, false);
  assert.match(choice.reason, /ax_snapshot/, 'Channel C guidance must send the model to read before it acts');
});

test('app_channel: every tool it names actually exists', () => {
  const known = new Set(TOOL_DEFINITIONS.map(t => t.name));
  for (const tool of channelATools()) {
    assert.ok(known.has(tool), `appChannel points at "${tool}", which is not a registered tool`);
  }
});

// ---------------------------------------------------------------------------
// C3 — the actuator
// ---------------------------------------------------------------------------

test('desktop_act: is registered, runnable, and in the system pack', () => {
  assert.ok(TOOL_DEFINITIONS.find(t => t.name === 'desktop_act'), 'desktop_act is not advertised');
  assert.equal(typeof toolRegistry.desktop_act?.execute, 'function', 'desktop_act cannot run');
  assert.ok(PACKS.system.includes('desktop_act'), 'desktop_act left the system pack');
});

test('HitL: every actuation is classified extreme, so the phone approves it in EVERY mode', () => {
  // agentLoop.js requests approval when risk === 'extreme', unconditionally —
  // not only in Mode A/B. Anything less and the most dangerous tool in the
  // project would run unannounced in Mode C.
  const sandbox = new Sandbox({ autonomyMode: 'C' });
  const verdict = sandbox.validate('desktop_act', { actions: [{ verb: 'type', text: 'x' }] });

  assert.equal(verdict.allowed, true, 'the capability must exist — gated, not walled');
  assert.equal(verdict.risk, 'extreme', 'desktop_act must always require human approval');
});

test('desktop_act: refuses an app that has a native channel, and names the tool to use', async () => {
  const result = await act({ app: 'Blender', actions: [{ verb: 'type', text: 'x' }] });
  assert.equal(result.success, false);
  assert.equal(result.useToolInstead, 'blender_act');
});

test('desktop_act: bounds the action count so one approval is not a blank cheque', async () => {
  const many = Array.from({ length: 30 }, () => ({ verb: 'wait', seconds: 0.01 }));
  const result = await act({ app: 'Notes', actions: many });

  assert.equal(result.success, false);
  assert.match(result.error, /ceiling is \d+/);
});

test('desktop_act: rejects an unknown verb rather than passing it to the interpreter', async () => {
  const result = await act({ app: 'Notes', actions: [{ verb: 'rm -rf', text: 'x' }] });
  assert.equal(result.success, false);
  assert.match(result.error, /unknown verb/);
});

test('desktop_act: rejects an action missing its argument', async () => {
  for (const action of [{ verb: 'press' }, { verb: 'type' }, { verb: 'clickxy', x: 'abc', y: 1 }]) {
    const result = await act({ app: 'Notes', actions: [action] });
    assert.equal(result.success, false, `${action.verb} with no valid argument was accepted`);
  }
});

test('desktop_act: strips the field separator so a typed string cannot reshape the action', () => {
  // Argument injection. The interpreter splits argv on '::', so text containing
  // '::' would silently become a different action. Validated here rather than
  // trusted from the model.
  assert.match(executable, /split\('::'\)\.join\(':'\)/, 'the separator guard is gone');
});

test('desktop_act: empty input is refused, not silently treated as a no-op', async () => {
  const result = await act({ app: 'Notes', actions: [] });
  assert.equal(result.success, false);
});

// ---------------------------------------------------------------------------
// Zero-Malware — the reason this tool is the most scrutinised in the project
// ---------------------------------------------------------------------------

test('ZM-06: the actuator adds no native input binding', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
  const declared = Object.keys(pkg.dependencies || {});
  for (const banned of ['nut-js', '@nut-tree/nut-js', 'robotjs', 'iohook', 'node-key-sender']) {
    assert.ok(!declared.includes(banned), `${banned} was added to package.json — an instant supply-chain flag`);
  }
});

test('ZM-05: no dropper — nothing is written to disk and executed', () => {
  assert.ok(
    !/writeFileSync|writeFile\(|createWriteStream|mkdtemp/.test(executable),
    'the actuator writes to disk; if that is a script, it is a dropper'
  );
  assert.match(executable, /child\.stdin\.write/, 'the script no longer reaches the interpreter over STDIN');
});





test('audit: an actuation is logged BEFORE it runs, and a refusal is logged too', () => {
  // A trail that only records what succeeded is not a trail.
  assert.match(executable, /auditLog\.log\(\{[\s\S]*?event: 'desktop_act'/, 'actuations are no longer audited');
  assert.match(executable, /event: 'desktop_act_channel_refused'/, 'channel refusals are no longer audited');

  const auditIndex = executable.indexOf("event: 'desktop_act'");
  const runIndex = executable.indexOf('runWithScriptOnStdin(\n');
  assert.ok(auditIndex > 0 && auditIndex < runIndex, 'the audit entry must be written before execution, not after');
});
