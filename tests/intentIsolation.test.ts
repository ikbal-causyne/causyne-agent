import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop, isDesktopWallpaperChangePrompt } from '../src/agentLoop.js';

test('an @ referenced source file cannot authorize an unrelated macOS wallpaper task', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-intent-source-'));
  const previousDirectory = process.cwd();
  try {
    fs.mkdirSync(path.join(workspace, 'causyne-agent', 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
    fs.writeFileSync(path.join(workspace, 'causyne-agent', 'src', 'agentLoop.js'),
      "export const example = 'change my desktop picture';\n");
    process.chdir(workspace);
    const prompt = '@causyne-agent/src/agentLoop.js just explain dont execute anything';
    const events: Array<{ type: string; message?: string }> = [];
    const loop = new AgentLoop(
      { readyState: 1, send: value => events.push(JSON.parse(value)) },
      'intent-wallpaper-readonly', prompt, { workspaceRoot: workspace }
    );
    loop.initializeProvider = () => ({
      supportsVision: false,
      supportsToolSearch: () => false,
      chat: async () => ({
        content: 'This referenced source contains a wallpaper-related example. No action was performed.',
        usage: { promptTokens: 100, completionTokens: 25 }
      })
    }) as never;
    await loop.run();
    assert.equal(loop.taskIntentPrompt, prompt);
    assert.ok(String(loop.currentTaskPrompt).includes('change my desktop picture'),
      'the reference must still reach the model context');
    assert.equal(loop._wallpaperChangeRequested, false,
      'referenced code must not become a desktop mutation request');
    assert.equal(events.some(event =>
      event.type === 'error' && /desktop wallpaper change was not confirmed/i.test(event.message || '')), false);
    assert.equal(events.some(event => event.type === 'task_complete'), true,
      'a read-only explanation must reach the normal completion path');
  } finally {
    process.chdir(previousDirectory);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('wallpaper detection requires an explicit wallpaper phrase in the request', () => {
  assert.equal(isDesktopWallpaperChangePrompt('@src/agentLoop.js just explain dont execute anything'), false);
  assert.equal(isDesktopWallpaperChangePrompt('please change my desktop picture'), true);
  assert.equal(isDesktopWallpaperChangePrompt('search and download a wallpaper and change my desktop picture'), true);
});
