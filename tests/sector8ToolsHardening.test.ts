import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertSafeWorkspaceInput,
  assertSafeWorkspaceOutput,
  escapeGodotString,
  escapeHtmlText,
  escapeJsString,
  isSafePlainKey,
  resolveScopedPath,
  resolveToolWorkspaceRoots,
  safeFilenameStrict,
  safeSlugIdentifier,
  stripDangerousKeysDeep
} from '../src/tools/toolPathSafety.js';
import { resolveTool, canonicalToolName } from '../src/tools/registry.js';
import { loadDynamicTools } from '../src/tools/dynamicLoader.js';
import { clipboard } from '../src/tools/clipboard.js';
import { fsDelete } from '../src/tools/fsDelete.js';
import { fsMove } from '../src/tools/fsMove.js';
import { toolForgeTool } from '../src/tools/toolForge.js';
import { astryxOracle } from '../src/tools/astryxOracle.js';
import { procTerm } from '../src/tools/procTerm.js';
import { gitExec, parseGitArguments } from '../src/tools/gitExec.js';
import { codeSearchAst } from '../src/tools/codeSearchAst.js';
import { pdfRead } from '../src/tools/pdfReader.js';
import { executeProceduralMedia } from '../src/tools/executeProceduralMedia.js';
import { godotAutomator } from '../src/tools/godotAutomator.js';
import { blenderAct } from '../src/tools/blenderAutomator.js';
import { gameBuilder } from '../src/tools/gameBuilder.js';
import { gameDialogueTreeGen } from '../src/tools/gameDialogueTreeGen.js';
import { gameQuestArcBuilder } from '../src/tools/gameQuestArcBuilder.js';
import { gameSceneBuilder } from '../src/tools/gameSceneBuilder.js';
import { gameAudioSynth } from '../src/tools/gameAudioSynth.js';
import { gameTilemapGenerator } from '../src/tools/gameTilemapGenerator.js';
import { gameEconomyBalancer } from '../src/tools/gameEconomyBalancer.js';
import { gameDataForge } from '../src/tools/gameDataForge.js';
import { gameEntitySpawner } from '../src/tools/gameEntitySpawner.js';
import { gameVfxEmitterGen } from '../src/tools/gameVfxEmitterGen.js';
import { gameLoreForge } from '../src/tools/gameLoreForge.js';
import { gameCanvasAudit } from '../src/tools/gameCanvasAudit.js';
import { gameWebRuntimeInspector } from '../src/tools/gameWebRuntimeInspector.js';

function makeTempWorkspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('toolPathSafety resolves workspace scope across spread contexts and blocks escapes', async () => {
  const ws = makeTempWorkspace('causyne-s8-scope-');
  const outside = makeTempWorkspace('causyne-s8-out-');
  try {
    // Simulates AgentLoop's { ...this.sandbox } spread that drops prototype methods.
    const spreadContext = { workspacePaths: [ws], grantAllAccess: false };
    const scope = resolveToolWorkspaceRoots(spreadContext);
    assert.equal(scope.primaryRoot, path.resolve(ws));

    const inner = resolveScopedPath('nested/file.txt', spreadContext);
    assert.equal(inner, path.join(path.resolve(ws), 'nested', 'file.txt'));
    assert.throws(() => resolveScopedPath(path.join(outside, 'secret.txt'), spreadContext), /outside the authorized workspace/);
    assert.throws(() => resolveScopedPath('bad\0name.txt', spreadContext), /NUL/);

    const safeOut = await assertSafeWorkspaceOutput(path.join(ws, 'out.txt'), spreadContext);
    assert.equal(safeOut, path.join(path.resolve(ws), 'out.txt'));
    await assert.rejects(assertSafeWorkspaceOutput(path.join(outside, 'escape.txt'), spreadContext), /outside the authorized workspace/);

    const existingFile = path.join(ws, 'input.txt');
    fs.writeFileSync(existingFile, 'hello', 'utf8');
    const checked = await assertSafeWorkspaceInput(existingFile, spreadContext, { maxBytes: 1024 });
    assert.equal(checked.size, 5);
    await assert.rejects(assertSafeWorkspaceInput(existingFile, spreadContext, { maxBytes: 2 }), /maximum allowed size/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('toolPathSafety escaping, identifier, filename, and prototype-pollution guards', () => {
  assert.equal(escapeHtmlText('<script>"x"&\'y\'</script>'), '&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;');
  assert.equal(escapeJsString('</script>\u2028'), '"\\u003c/script\\u003e\\u2028"');
  assert.equal(escapeGodotString('Hero"\n[node name="Evil"]'), 'Hero\\" [node name=\\"Evil\\"]');
  assert.equal(safeSlugIdentifier('../../evil/path!@#', 'fallback'), 'evil_path');
  assert.equal(safeFilenameStrict('valid_file.json'), 'valid_file.json');
  assert.equal(safeFilenameStrict('../escape.json'), null);
  assert.equal(safeFilenameStrict('CON.txt'), null);
  assert.equal(isSafePlainKey('__proto__'), false);
  assert.equal(isSafePlainKey('constructor'), false);
  assert.equal(isSafePlainKey('prototype'), false);
  assert.equal(isSafePlainKey('quest_1'), true);

  const polluted = JSON.parse('{"ok":1,"__proto__":{"polluted":true},"nested":{"constructor":"bad","keep":2}}') as Record<string, unknown>;
  const cleaned = stripDangerousKeysDeep(polluted) as Record<string, unknown>;
  assert.equal(cleaned.ok, 1);
  assert.equal(Object.hasOwn(cleaned, '__proto__'), false);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.deepEqual(cleaned.nested, { keep: 2 });
});

test('registry blocks prototype properties and dynamicLoader fails closed', async () => {
  assert.equal(resolveTool('toString'), null);
  assert.equal(resolveTool('constructor'), null);
  assert.equal(resolveTool('__proto__'), null);
  assert.equal(canonicalToolName('toString'), 'toString');

  const dyn = await loadDynamicTools();
  assert.deepEqual(Object.keys(dyn), []);
  assert.equal(Object.getPrototypeOf(dyn), null);
});

test('clipboard rejects oversized writes and unknown actions before invoking clipboardy', async () => {
  const badAction = await clipboard.execute({ action: 'invalid' as 'read' });
  assert.equal(badAction.success, false);
  const bigWrite = await clipboard.execute({ action: 'write', text: 'x'.repeat(256 * 1024 + 1) });
  assert.equal(bigWrite.success, false);
});

test('fsDelete and fsMove enforce workspace boundaries and block workspace root deletion', async () => {
  const ws = makeTempWorkspace('causyne-s8-fs-');
  const outside = makeTempWorkspace('causyne-s8-fs-out-');
  try {
    const ctx = { workspacePaths: [ws], grantAllAccess: false };
    const outFile = path.join(outside, 'keep.txt');
    fs.writeFileSync(outFile, 'keep', 'utf8');

    const rootDel = await fsDelete.execute({ path: ws, recursive: true }, ctx);
    assert.equal(rootDel.success, false);
    assert.match(String(rootDel.error), /workspace root/i);

    const outDel = await fsDelete.execute({ path: outFile }, ctx);
    assert.equal(outDel.success, false);
    assert.equal(fs.existsSync(outFile), true);

    const inFile = path.join(ws, 'a.txt');
    fs.writeFileSync(inFile, 'data', 'utf8');
    const escapeMove = await fsMove.execute({ source: inFile, destination: path.join(outside, 'stolen.txt') }, ctx);
    assert.equal(escapeMove.success, false);
    assert.equal(fs.existsSync(inFile), true);

    const sameMove = await fsMove.execute({ source: inFile, destination: inFile }, ctx);
    assert.equal(sameMove.success, false);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('toolForge handles pathological names linearly and rejects invalid JSON/actions safely', async () => {
  const start = Date.now();
  const res = await toolForgeTool.execute({
    action: 'create',
    name: `${'-'.repeat(50000)}tool${'-'.repeat(50000)}`,
    parametersSchema: '{invalid json'
  });
  const elapsed = Date.now() - start;
  assert.equal(res.success, false);
  assert.ok(elapsed < 1000, `Expected linear-time validation, took ${elapsed}ms`);
});

test('astryxOracle rejects flag-only injection targets cleanly', async () => {
  const flagRes = await astryxOracle.execute({ command: 'read_component', target: '----' });
  assert.equal(flagRes.success, false);
  assert.match(String(flagRes.error), /target component name is required/);
});

test('procTerm blocks invalid signals, pid<=1, self PID, and short process names', async () => {
  const badSig = await procTerm.execute({ pid: 999999, signal: 'SIGFAKE' });
  assert.equal(badSig.success, false);

  const pid1 = await procTerm.execute({ pid: 1 });
  assert.equal(pid1.success, false);

  const selfKill = await procTerm.execute({ pid: process.pid });
  assert.equal(selfKill.success, false);

  const shortName = await procTerm.execute({ name: 'a' });
  assert.equal(shortName.success, false);
});

test('gitExec blocks NUL bytes, option/config injection, and out-of-workspace cwd', async () => {
  assert.throws(() => parseGitArguments('status\0--short'), /NUL/);

  const ws = makeTempWorkspace('causyne-s8-git-');
  const outside = makeTempWorkspace('causyne-s8-git-out-');
  try {
    const ctx = { workspacePaths: [ws], grantAllAccess: false };
    for (const cmd of [
      '-c core.sshCommand=id status',
      'status --exec-path=/tmp',
      'config core.fsmonitor evil',
      'clone --upload-pack=id https://example.com/repo.git'
    ]) {
      const res = await gitExec.execute({ command: cmd, cwd: ws }, ctx);
      assert.equal(res.success, false, `Expected rejection for: ${cmd}`);
    }

    const escapeCwd = await gitExec.execute({ command: 'status', cwd: outside }, ctx);
    assert.equal(escapeCwd.success, false);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('codeSearchAst returns structured error and enforces workspace boundary', async () => {
  const ws = makeTempWorkspace('causyne-s8-ast-');
  const outside = makeTempWorkspace('causyne-s8-ast-out-');
  try {
    const ctx = { workspacePaths: [ws], grantAllAccess: false };
    const outJs = path.join(outside, 'a.js');
    fs.writeFileSync(outJs, 'function secret() {}', 'utf8');
    const blocked = await codeSearchAst.execute({ targetFile: outJs }, ctx);
    assert.equal(typeof blocked, 'object');
    assert.equal(blocked.success, false);

    const inJs = path.join(ws, 'sample.js');
    fs.writeFileSync(inJs, 'export function greet(name) { return name; }\n', 'utf8');
    const ok = await codeSearchAst.execute({ targetFile: inJs }, ctx);
    assert.equal(ok.success, true);
    assert.match(String(ok.output), /greet/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('pdfRead validates %PDF- header, workspace boundary, and resists ReDoS', async () => {
  const ws = makeTempWorkspace('causyne-s8-pdf-');
  try {
    const ctx = { workspacePaths: [ws], grantAllAccess: false };
    const notPdf = path.join(ws, 'fake.pdf');
    fs.writeFileSync(notPdf, 'not a pdf file', 'utf8');
    const rej = await pdfRead.execute({ path: notPdf }, ctx);
    assert.equal(rej.success, false);
    assert.match(String(rej.error), /%PDF-/);

    const evilPdf = path.join(ws, 'redos.pdf');
    fs.writeFileSync(evilPdf, '%PDF-1.4\n(' + 'a'.repeat(50000), 'latin1');
    const start = Date.now();
    const res = await pdfRead.execute({ path: evilPdf }, ctx);
    assert.equal(res.success, true);
    assert.ok(Date.now() - start < 2000, 'PDF scanner must run in linear time');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('executeProceduralMedia enforces workspace boundary and runs JS safely without shell', async () => {
  const ws = makeTempWorkspace('causyne-s8-proc-');
  const outside = makeTempWorkspace('causyne-s8-proc-out-');
  try {
    const ctx = { workspacePaths: [ws], grantAllAccess: false };
    const blocked = await executeProceduralMedia.execute({
      language: 'javascript',
      code: 'console.log("x")',
      outputFileName: path.join(outside, 'escape.txt')
    }, ctx);
    assert.equal(blocked.success, false);

    const target = path.join(ws, 'out.txt');
    const ok = await executeProceduralMedia.execute({
      language: 'javascript',
      code: `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'ok');`,
      outputFileName: target
    }, ctx);
    assert.equal(ok.success, true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'ok');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('godotAutomator and blenderAct enforce workspace containment, escaping, and fallback contracts', async () => {
  const ws = makeTempWorkspace('causyne-s8-engines-');
  const outside = makeTempWorkspace('causyne-s8-engines-out-');
  try {
    const ctx = { workspacePaths: [ws], grantAllAccess: false };
    const godotOut = await godotAutomator.execute({
      action: 'create_project',
      projectDir: path.join(outside, 'escape_godot')
    }, ctx);
    assert.equal(godotOut.success, false);

    const godotOk = await godotAutomator.execute({
      action: 'create_project',
      projectDir: path.join(ws, 'my_game'),
      projectName: 'Hero"\n[evil]'
    }, ctx);
    assert.equal(godotOk.success, true);
    const projectGodot = fs.readFileSync(path.join(ws, 'my_game', 'project.godot'), 'utf8');
    assert.doesNotMatch(projectGodot, /\n\[evil\]/);

    const blenderMissing = await blenderAct.execute({ simulateMissing: true, actions: [] }, ctx);
    assert.equal(blenderMissing.success, false);
    assert.equal(blenderMissing.status, 'fallback_required');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('gameBuilder escapes HTML/JS titles and blocks filename traversal', async () => {
  const ws = makeTempWorkspace('causyne-s8-gamebld-');
  try {
    const ctx = { workspacePaths: [ws], grantAllAccess: false };
    const badFile = await gameBuilder.execute({
      title: 'Test',
      engine: 'canvas2d',
      outputDir: ws,
      filename: '../escape.html'
    }, ctx);
    assert.equal(badFile.success, false);

    const ok = await gameBuilder.execute({
      title: '</title><script>alert(1)</script>',
      engine: 'canvas2d',
      template: 'topdown_rpg_2d',
      outputDir: ws,
      filename: 'safe.html'
    }, ctx);
    assert.equal(ok.success, true);
    const html = fs.readFileSync(path.join(ws, 'safe.html'), 'utf8');
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.match(html, /&lt;\/title&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('gameDialogueTreeGen and gameQuestArcBuilder block prototype pollution and workspace escapes', async () => {
  const ws = makeTempWorkspace('causyne-s8-rpg-');
  const outside = makeTempWorkspace('causyne-s8-rpg-out-');
  try {
    const ctx = { workspacePaths: [ws], grantAllAccess: false };
    const badNpc = await gameDialogueTreeGen.execute({ action: 'create_tree', npcId: '__proto__', projectDir: ws }, ctx);
    assert.equal(badNpc.success, false);

    const badQuest = await gameQuestArcBuilder.execute({ action: 'create_quest_arc', questId: 'constructor', projectDir: ws }, ctx);
    assert.equal(badQuest.success, false);

    const outQuest = await gameQuestArcBuilder.execute({ action: 'save_quest_db', questId: 'q1', projectDir: outside }, ctx);
    assert.equal(outQuest.success, false);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('gameSceneBuilder, gameDataForge, gameEntitySpawner, gameVfxEmitterGen, gameAudioSynth, gameTilemapGenerator, gameEconomyBalancer, and gameLoreForge enforce workspace/input guards', async () => {
  const ws = makeTempWorkspace('causyne-s8-forge-');
  const outside = makeTempWorkspace('causyne-s8-forge-out-');
  try {
    const ctx = { workspacePaths: [ws], grantAllAccess: false };

    const missingBind = await gameSceneBuilder.execute({
      action: 'bind_signal',
      scenePath: path.join(ws, 'missing.tscn'),
      signalConfig: { signal_name: 'pressed', from_node: 'Btn', to_node: '.', method_name: '_on_btn' }
    }, ctx);
    assert.equal(missingBind.success, false);

    const badDataFile = await gameDataForge.execute({
      action: 'save_data_forge',
      projectDir: ws,
      targetFilename: '../escape.json',
      customJsonData: { a: 1 }
    }, ctx);
    assert.equal(badDataFile.success, false);

    const spawnSafe = await gameEntitySpawner.execute({
      action: 'spawn_prefab',
      prefabType: 'player_hero_2d',
      entityName: '../../evil_actor',
      projectDir: ws
    }, ctx);
    assert.equal(spawnSafe.success, true);
    assert.equal(fs.existsSync(path.join(ws, 'scripts', 'actors', 'evil_actor.gd')), true);

    const vfx = await gameVfxEmitterGen.execute({
      action: 'generate_emitter',
      effectType: 'raging_fire',
      colorHex: 'not-a-hex',
      amount: 999999,
      outputPath: path.join(ws, 'fire.tscn')
    }, ctx);
    assert.equal(vfx.success, true);
    const vfxText = fs.readFileSync(path.join(ws, 'fire.tscn'), 'utf8');
    assert.match(vfxText, /color = Color\("#ff006e"\)/);
    assert.match(vfxText, /amount = 4096/);

    const audioEscape = await gameAudioSynth.execute({
      action: 'synthesize_sfx',
      sfxType: 'laser',
      outputPath: path.join(outside, 'escape.wav')
    }, ctx);
    assert.equal(audioEscape.success, false);

    const tileEscape = await gameTilemapGenerator.execute({
      action: 'save_tilemap_scene',
      levelName: 'L1',
      outputPath: path.join(outside, 'escape.tscn')
    }, ctx);
    assert.equal(tileEscape.success, false);

    const econCheck = await gameEconomyBalancer.execute({ action: 'save_economy_data', projectDir: ws }, ctx);
    assert.equal(econCheck.success, true);
    assert.match(String(econCheck.output), /NO_ECONOMY_DATA_FOUND/);

    const loreEscape = await gameLoreForge.execute({
      action: 'save_lore_to_project',
      title: 'World',
      projectDir: outside
    }, ctx);
    assert.equal(loreEscape.success, false);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('gameCanvasAudit and gameWebRuntimeInspector reject SSRF metadata and non-HTML local files', async () => {
  const ws = makeTempWorkspace('causyne-s8-inspect-');
  try {
    const ctx = { workspacePaths: [ws], grantAllAccess: false };
    const secretTxt = path.join(ws, 'notes.txt');
    fs.writeFileSync(secretTxt, 'plain text', 'utf8');

    const ssrfCanvas = await gameCanvasAudit.execute({ url: 'http://169.254.169.254/latest/meta-data/' }, ctx);
    assert.equal(ssrfCanvas.success, false);

    const nonHtmlCanvas = await gameCanvasAudit.execute({ url: secretTxt }, ctx);
    assert.equal(nonHtmlCanvas.success, false);

    const ssrfRuntime = await gameWebRuntimeInspector.execute({ url: 'http://169.254.169.254/latest/meta-data/' }, ctx);
    assert.equal(ssrfRuntime.success, false);

    const nonHtmlRuntime = await gameWebRuntimeInspector.execute({ url: `file://${secretTxt}` }, ctx);
    assert.equal(nonHtmlRuntime.success, false);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
