import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { detectTrigger, suggest, applyCompletion, FileIndex } from '../src/tui/completion.js';
import { extractMentions, resolveMentionedContext } from '../src/promptMentions.js';
import { WorkspacePerception } from '../src/perception.js';
import { handleInput, listCommands } from '../src/commands.js';

describe('Workspace @ mentions and file/folder scoping', () => {
  const setupTestWorkspace = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-workspace-test-'));
    
    // Subproject 1: pixel2d games
    const gameDir = path.join(root, 'pixel2d games');
    fs.mkdirSync(path.join(gameDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(gameDir, 'package.json'), JSON.stringify({
      name: 'pixel2d-game',
      dependencies: { 'phaser': '^3.80.0' }
    }));
    fs.writeFileSync(path.join(gameDir, 'main.js'), 'console.log("pixel2d game start");\nconst player = { x: 10, y: 20 };');
    fs.writeFileSync(path.join(gameDir, 'src', 'player.js'), 'export class Player { move() {} }');

    // Subproject 2: backend service
    const backendDir = path.join(root, 'backend');
    fs.mkdirSync(path.join(backendDir, 'api'), { recursive: true });
    fs.writeFileSync(path.join(backendDir, 'package.json'), JSON.stringify({
      name: 'backend-api',
      dependencies: { 'express': '^4.19.0' }
    }));
    fs.writeFileSync(path.join(backendDir, 'server.js'), 'const express = require("express");');

    // Root level files
    fs.writeFileSync(path.join(root, 'README.md'), '# Master Workspace\nMulti-project repo.');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root-workspace' }));

    return { root, gameDir, backendDir };
  };

  test('detectTrigger handles unquoted and quoted mentions with spaces', () => {
    // Unquoted
    const t1 = detectTrigger('edit @src/', 10);
    assert.ok(t1);
    assert.equal(t1.kind, 'file');
    assert.equal(t1.quote, null);
    assert.equal(t1.query, 'src/');

    // Quoted with spaces (e.g. @"pixel2d games/)
    const t2 = detectTrigger('look at @"pixel2d games/', 24);
    assert.ok(t2);
    assert.equal(t2.kind, 'file');
    assert.equal(t2.quote, '"');
    assert.equal(t2.query, 'pixel2d games/');

    // Single quoted
    const t3 = detectTrigger("check @'my folder/", 18);
    assert.ok(t3);
    assert.equal(t3.kind, 'file');
    assert.equal(t3.quote, "'");
    assert.equal(t3.query, 'my folder/');
  });

  test('applyCompletion wraps paths with spaces in quotes and preserves directory drill-in', () => {
    // 1. Directory with spaces: drilling in must keep open quote and have no trailing space
    const dirTrigger = detectTrigger('check @pix', 10);
    const dirApplied = applyCompletion('check @pix', 10, dirTrigger, { value: 'pixel2d games/' });
    assert.equal(dirApplied.text, 'check @"pixel2d games/');
    assert.equal(dirApplied.cursor, 'check @"pixel2d games/'.length);

    // 2. Next keystroke drilling into the quoted directory continues completion
    const continuedText = 'check @"pixel2d games/m';
    const continuedTrigger = detectTrigger(continuedText, continuedText.length);
    assert.ok(continuedTrigger);
    assert.equal(continuedTrigger.query, 'pixel2d games/m');
    assert.equal(continuedTrigger.quote, '"');

    // 3. Completing a file closes the quote and appends a space
    const fileApplied = applyCompletion(continuedText, continuedText.length, continuedTrigger, { value: 'pixel2d games/main.js' });
    assert.equal(fileApplied.text, 'check @"pixel2d games/main.js" ');
    assert.equal(fileApplied.cursor, 'check @"pixel2d games/main.js" '.length);

    // 4. Standard unquoted file without spaces has no quotes
    const plainTrigger = detectTrigger('@alph', 5);
    const plainApplied = applyCompletion('@alph', 5, plainTrigger, { value: 'alpha.txt' });
    assert.equal(plainApplied.text, '@alpha.txt ');
  });

  test('suggest prioritizes focused subproject files via focusDir', async () => {
    const { root } = setupTestWorkspace();

    // 1. Unindexed with focusDir = 'pixel2d games'
    const unindexed = suggest('@main', 5, { root, focusDir: 'pixel2d games' });
    assert.ok(unindexed);
    assert.ok(unindexed.items.length > 0);
    assert.equal(unindexed.items[0].value, 'pixel2d games/main.js', 'Focused project file must rank first');

    // 2. Indexed with focusDir
    const index = new FileIndex(root);
    await index.ensure();
    const indexed = suggest('@main', 5, { root, index, focusDir: 'pixel2d games' });
    assert.ok(indexed);
    assert.ok(indexed.items.length > 0);
    assert.equal(indexed.items[0].value, 'pixel2d games/main.js', 'Indexed focused file must rank first');

    fs.rmSync(root, { recursive: true, force: true });
  });

  test('extractMentions parses both quoted and unquoted mentions', () => {
    const prompt = 'Please refactor @"pixel2d games/main.js" and @backend/server.js and @pixel2d games/src/player.js';
    const mentions = extractMentions(prompt);
    
    const paths = mentions.map(m => m.path);
    assert.ok(paths.includes('pixel2d games/main.js'));
    assert.ok(paths.includes('backend/server.js'));
  });

  test('resolveMentionedContext loads file contents and folder listings', async () => {
    const { root } = setupTestWorkspace();

    const prompt = 'Fix bug in @"pixel2d games/main.js" and check folder @"pixel2d games/src/"';
    const resolved = await resolveMentionedContext(prompt, { cwd: root, subprojects: ['pixel2d games', 'backend'] });

    assert.equal(resolved.detectedSubproject, 'pixel2d games');
    assert.ok(resolved.referencedContext.includes('REFERENCED FILE: pixel2d games/main.js'));
    assert.ok(resolved.referencedContext.includes('pixel2d game start'));
    assert.ok(resolved.referencedContext.includes('REFERENCED DIRECTORY: pixel2d games/src/'));
    assert.ok(resolved.referencedContext.includes('player.js'));

    fs.rmSync(root, { recursive: true, force: true });
  });

  test('WorkspacePerception discovers subprojects, cwd, packageManager and projectType', async () => {
    const { root, gameDir } = setupTestWorkspace();
    const perception = new WorkspacePerception();

    // 1. Scanned at root
    const rootCtx = await perception.buildContext(root);
    assert.equal(rootCtx.cwd, root);
    assert.ok(rootCtx.subprojects.includes('pixel2d games'));
    assert.ok(rootCtx.subprojects.includes('backend'));
    assert.ok(Array.isArray(rootCtx.keyFiles));
    assert.equal(typeof String(rootCtx.os), 'string');
    assert.ok(!String(rootCtx.os).includes('[object Object]'));

    // 2. Scanned inside gameDir (pixel2d games)
    const gameCtx = await perception.buildContext(gameDir);
    assert.equal(gameCtx.cwd, gameDir);
    assert.equal(gameCtx.projectName, 'pixel2d games');
    assert.ok(gameCtx.projectType.includes('Game'));

    fs.rmSync(root, { recursive: true, force: true });
  });

  test('/cd command switches working directory and updates prompt and perception', async () => {
    const { root, gameDir } = setupTestWorkspace();
    const origCwd = process.cwd();

    try {
      let promptUpdatedRoot = null;
      const fakePrompt = {
        setWorkingRoot: (newRoot) => { promptUpdatedRoot = newRoot; }
      };

      const result = await handleInput(`/cd "${gameDir}"`, { prompt: fakePrompt });
      assert.ok(result.ok);
      assert.equal(fs.realpathSync(process.cwd()), fs.realpathSync(gameDir));
      assert.equal(fs.realpathSync(promptUpdatedRoot), fs.realpathSync(gameDir));
    } finally {
      process.chdir(origCwd);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
