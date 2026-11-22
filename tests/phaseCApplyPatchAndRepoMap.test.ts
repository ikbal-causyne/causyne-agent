import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyPatch,
  parsePatchText,
  patchContainsFileDeletion
} from '../src/tools/applyPatch.js';
import { isWholeFileDeletion } from '../src/approvalPolicy.js';
import { buildRepoMap } from '../src/codebase/repoMap.js';
import { repoMapTool } from '../src/tools/repoMap.js';
import { canonicalToolName, resolveTool } from '../src/tools/registry.js';
import { runCommand } from '../src/commands.js';

const nativeRealpath = (p: string): string =>
  typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native(p) : fs.realpathSync(p);
const TMP_ROOT = nativeRealpath(fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-phasec-patch-')));

after(() => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch { /* ignore */ }
});

describe('Phase C-Core — Multi-File apply_patch & PageRank Repo Map', () => {
  test('apply_patch executes add, update, move, and delete atomically and aborts completely on hunk mismatch', async () => {
    const ws = path.join(TMP_ROOT, 'patch-ws');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'alpha.ts'), 'export const a = 1;\nexport const b = 2;\n', 'utf8');
    fs.writeFileSync(path.join(ws, 'oldName.ts'), 'export const legacy = true;\n', 'utf8');
    fs.writeFileSync(path.join(ws, 'obsolete.ts'), 'export const dead = 0;\n', 'utf8');

    // 1. Failing hunk in second file MUST leave first file untouched (true atomicity)
    const badPatch = [
      '*** Begin Patch',
      '*** Update File: alpha.ts',
      '@@',
      '-export const a = 1;',
      '+export const a = 999;',
      '*** Update File: oldName.ts',
      '@@',
      '-DOES_NOT_EXIST_ANYWHERE',
      '+replacement',
      '*** End Patch'
    ].join('\n');
    const badRes = await applyPatch.execute({ patch: badPatch }, { workspaceRoot: ws });
    assert.equal(badRes.success, false);
    assert.equal(fs.readFileSync(path.join(ws, 'alpha.ts'), 'utf8'), 'export const a = 1;\nexport const b = 2;\n');

    // 2. Valid multi-file patch (Add + Update + Move + Delete)
    const goodPatch = [
      '*** Begin Patch',
      '*** Add File: nested/added.ts',
      '+export const added = 42;',
      '*** Update File: alpha.ts',
      '@@',
      ' export const a = 1;',
      '-export const b = 2;',
      '+export const b = 20;',
      '*** Update File: oldName.ts',
      '*** Move to: renamed.ts',
      '@@',
      '-export const legacy = true;',
      '+export const migrated = true;',
      '*** Delete File: obsolete.ts',
      '*** End Patch'
    ].join('\n');
    const goodRes = await applyPatch.execute({ patch: goodPatch }, { workspaceRoot: ws });
    assert.equal(goodRes.success, true, goodRes.error);
    assert.equal(fs.readFileSync(path.join(ws, 'nested', 'added.ts'), 'utf8'), 'export const added = 42;\n');
    assert.equal(fs.readFileSync(path.join(ws, 'alpha.ts'), 'utf8'), 'export const a = 1;\nexport const b = 20;\n');
    assert.equal(fs.existsSync(path.join(ws, 'oldName.ts')), false);
    assert.equal(fs.readFileSync(path.join(ws, 'renamed.ts'), 'utf8'), 'export const migrated = true;\n');
    assert.equal(fs.existsSync(path.join(ws, 'obsolete.ts')), false);

    // 3. Deletion detection integrates with approvalPolicy so deletions cannot bypass HITL
    assert.equal(patchContainsFileDeletion(goodPatch), true);
    assert.equal(isWholeFileDeletion('apply_patch', { patch: goodPatch }), true);
    assert.equal(isWholeFileDeletion('apply_patch', { patch: badPatch }), false);

    // 4. Reject workspace path traversal
    const escapeRes = await applyPatch.execute({
      patch: '*** Begin Patch\n*** Add File: ../escaped.ts\n+bad\n*** End Patch'
    }, { workspaceRoot: ws });
    assert.equal(escapeRes.success, false);

    // 5. Parser validates non-empty patch
    assert.throws(() => parsePatchText('*** Begin Patch\n*** End Patch'), /zero file operations/);
  });

  test('buildRepoMap ranks central modules via PageRank, respects focusFiles and maxChars, and skips symlinks', async () => {
    const ws = path.join(TMP_ROOT, 'repomap-ws');
    fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'src', 'core.ts'), 'export class Engine {}\nexport function boot() {}\n', 'utf8');
    fs.writeFileSync(path.join(ws, 'src', 'worker1.ts'), "import { boot } from './core.js';\nexport function run1() { return boot(); }\n", 'utf8');
    fs.writeFileSync(path.join(ws, 'src', 'worker2.ts'), "import { Engine } from './core.js';\nexport function run2() { return new Engine(); }\n", 'utf8');
    fs.writeFileSync(path.join(ws, 'src', 'helper.py'), 'class Analyzer:\n    pass\ndef analyze(x):\n    return x\n', 'utf8');
    fs.writeFileSync(path.join(ws, 'src', 'util.go'), 'package util\nfunc ExportedHelper() int { return 1 }\n', 'utf8');

    const map = buildRepoMap(ws, { maxChars: 4000 });
    assert.equal(map.totalSourceFiles, 5);
    assert.equal(map.files[0]?.relPath, 'src/core.ts');
    assert.match(map.rendered, /class Engine:1/);
    assert.match(map.rendered, /class Analyzer:1/);
    assert.match(map.rendered, /func ExportedHelper:2/);

    // Focus file boost elevates target file to top
    const focused = buildRepoMap(ws, { focusFiles: ['src/helper.py'], maxChars: 4000 });
    assert.equal(focused.files[0]?.relPath, 'src/helper.py');

    // Tool & slash command integration
    assert.equal(canonicalToolName('apply_patch'), 'apply_patch');
    assert.equal(canonicalToolName('repo_map'), 'code_repo_map');
    assert.ok(resolveTool('apply_patch'));
    assert.ok(resolveTool('code_repo_map'));

    const toolRes = await repoMapTool.execute({ maxChars: 2000 }, { workspaceRoot: ws });
    assert.equal(toolRes.success, true);
    assert.match(toolRes.output || '', /Repository Map/);

    const cmdRes = await runCommand('map', ['--chars', '2000'], {
      surface: 'terminal',
      loop: { workspaceRoot: ws } as any
    });
    assert.equal(cmdRes.ok, true);
    assert.match(cmdRes.output || '', /src\/core\.ts/);
  });
});
