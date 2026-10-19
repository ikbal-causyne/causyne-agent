import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { axSnapshot } from '../src/tools/axSnapshot.js';
import { TOOL_DEFINITIONS, toolRegistry } from '../src/tools/registry.js';
import { PACKS } from '../src/toolPacks.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, '..', 'src', 'tools', 'axSnapshot.js'), 'utf8');

// Comments in the tool explain the ZM rules by naming them. Strip comments
// before asserting on code, or the test passes on its own documentation.
const executable = SOURCE
  .split('\n')
  .filter(line => {
    const t = line.trim();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  })
  .join('\n');

test('ax_snapshot: is registered and runnable, not just advertised', () => {
  const definition = TOOL_DEFINITIONS.find(t => t.name === 'ax_snapshot');
  assert.ok(definition, 'ax_snapshot is not in TOOL_DEFINITIONS');
  assert.ok(typeof toolRegistry.ax_snapshot?.execute === 'function', 'ax_snapshot has no runnable execute()');
});

test('ax_snapshot: lives in the system pack, not the always-loaded core', () => {
  // Channel B is only worth its tokens on a GUI task. Most tasks are not.
  assert.ok(PACKS.system.includes('ax_snapshot'), 'ax_snapshot left the system pack');
});

test('ax_snapshot: the schema stays cheap enough to be worth deferring for', () => {
  const definition = TOOL_DEFINITIONS.find(t => t.name === 'ax_snapshot');
  const tokens = Math.round(JSON.stringify(definition).length / 4);
  assert.ok(tokens <= 320, `ax_snapshot schema is ${tokens} tok; budget is 320`);
});

test('ZM-06: adds no dependency — the OS scripting bridge is not a package', async () => {
  // The plan assumed a native input binding provisioned at runtime. It is not
  // needed, and a keyboard/mouse library in package.json is an instant
  // supply-chain flag. Assert the tool pulls in nothing new.
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
  const declared = Object.keys(pkg.dependencies || {});
  for (const banned of ['nut-js', '@nut-tree/nut-js', 'robotjs', 'node-mac-permissions']) {
    assert.ok(!declared.includes(banned), `${banned} was added to package.json — ZM-06 violation`);
  }
  assert.ok(!/from ['"]nut-js|from ['"]robotjs/.test(executable), 'a native input binding was imported');
});

test('ZM-05: the readable script goes to STDIN, never to disk', () => {
  // Writing an executable script to disk and running it is the literal
  // definition of a dropper and has cost this package two advisories.
  assert.ok(
    !/writeFileSync|writeFile\(|createWriteStream/.test(executable),
    'ax_snapshot writes to disk — if that is a script, it is a dropper (ZM-05)'
  );
  assert.match(executable, /child\.stdin\.write/, 'the script no longer reaches the interpreter over STDIN');
});





test('ax_snapshot: output is bounded so one look cannot blow the context', () => {
  const ceiling = executable.match(/MAX_NODES_CEILING\s*=\s*(\d+)/);
  assert.ok(ceiling, 'the node ceiling is gone');
  assert.ok(Number(ceiling[1]) <= 200, `ceiling is ${ceiling[1]}; a Channel B read must stay cheaper than a screenshot`);
});

test('ax_snapshot: an unsupported platform says so instead of returning an empty tree', async () => {
  // An empty result reads to the model as "the window is empty", which is a
  // silent wrong answer. Saying "not supported here, use OCR" is not.
  if (process.platform === 'darwin' || process.platform === 'win32') return;
  const result = await axSnapshot.execute({});
  assert.equal(result.success, false);
  assert.match(result.error, /macOS and Windows/);
});

test('ax_snapshot: a missing OS permission is reported as consent, not as failure', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS-only path');

  const result = await axSnapshot.execute({ maxNodes: 5 });

  if (!result.success && /\(-10827\)/.test(result.error || '')) {
    return t.skip('macOS cannot launch System Events in this test environment (-10827); desktop integration needs an interactive host check');
  }

  // Either Accessibility is granted on this machine (real tree) or it is not
  // (consent request). Both are correct; a bare crash is not.
  if (result.success) {
    assert.equal(typeof result.output, 'string');
    return;
  }
  assert.equal(result.requiresConsent, true, `expected a consent request, got: ${result.error}`);
  assert.match(result.error, /System Settings/, 'the consent message must tell the user exactly where to go');
});
