import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { selfRepairToolCall } from '../src/tools/toolSelfRepair.js';
import { Sandbox } from '../src/sandbox.js';

test('workspace HTML file navigation becomes a safe preview with a screenshot destination', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-browser-repair-'));
  try {
    const page = path.join(workspace, 'index.html');
    fs.writeFileSync(page, '<h1>Preview</h1>');
    const call = selfRepairToolCall({ name: 'browser_act', arguments: {
      actions: [{ type: 'goto', url: pathToFileURL(page).href }, { type: 'screenshot' }]
    } }, undefined, { cwd: workspace });
    const actions = call.args.actions as Record<string, string>[];
    assert.deepEqual(actions[0], { type: 'preview', filePath: 'index.html' });
    assert.match(actions[1]!.outputFile!, /^browser-capture-[\w-]+\.png$/);
    assert.equal(new Sandbox({ workspaceRoot: workspace }).validate('browser_act', call.args).risk, 'extreme');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('local files outside the workspace are never converted to browser preview', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-browser-workspace-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-browser-outside-'));
  try {
    const page = path.join(outside, 'private.html');
    fs.writeFileSync(page, '<h1>Private</h1>');
    const call = selfRepairToolCall({ name: 'browser_act', arguments: {
      actions: [{ type: 'goto', url: pathToFileURL(page).href }]
    } }, undefined, { cwd: workspace });
    assert.equal((call.args.actions as Record<string, string>[])[0]?.type, 'goto');
    assert.equal(new Sandbox({ workspaceRoot: workspace }).validate('browser_act', call.args).risk, 'forbidden');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('single browser actions and action aliases use the same local preview repair', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-browser-single-'));
  try {
    const page = path.join(workspace, 'page.html');
    fs.writeFileSync(page, '<h1>Preview</h1>');
    const single = selfRepairToolCall({ name: 'browser_act', arguments: {
      action: 'goto', url: pathToFileURL(page).href
    } }, undefined, { cwd: workspace });
    const singleActions = single.args.actions as Record<string, string>[];
    assert.equal(singleActions[0]?.type, 'preview');
    assert.equal(singleActions[0]?.filePath, 'page.html');
    const aliased = selfRepairToolCall({ name: 'browser_act', arguments: {
      actions: [{ action: 'goto', url: pathToFileURL(page).href }, { action: 'screenshot' }]
    } }, undefined, { cwd: workspace });
    const actions = aliased.args.actions as Record<string, string>[];
    assert.equal(actions[0]?.type, 'preview');
    assert.equal(actions[1]?.type, 'screenshot');
    assert.match(actions[1]!.outputFile!, /^browser-capture-[\w-]+\.png$/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
