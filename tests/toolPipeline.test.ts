import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildToolsList, renderToolsList, findListedTool } from '../src/toolsList.js';
import { decideTools } from '../src/decideTools.js';
import { refineToolDecision } from '../src/smartToolsUse.js';
import { SavedTools, writeSavedTools, readSavedTools, savedToolsPath } from '../src/saveTools.js';
import { TOOL_DEFINITIONS } from '../src/tools/registry.js';
import { assessVerification } from '../src/verificationPlan.js';

test('toolsList builds dense definitions across tool groups and renders markdown', () => {
  const list = buildToolsList(TOOL_DEFINITIONS);
  assert.ok(list.length >= 25);
  const coreTools = list.filter(t => t.group === 'core');
  assert.ok(coreTools.length >= 6);
  assert.ok(list.some(t => t.name === 'fs_read'));
  assert.ok(list.some(t => t.name === 'sysRun'));
  assert.ok(list.some(t => t.name === 'update_plan'));

  const rendered = renderToolsList(list);
  assert.match(rendered, /# TOOLS LIST/);
  assert.match(rendered, /core:/);
  assert.match(rendered, /fs_read:/);

  const found = findListedTool(list, 'fs_read');
  assert.ok(found);
  assert.equal(found?.name, 'fs_read');
  assert.equal(found?.group, 'core');
});

test('decideTools routes tools from intent, text, requests, and plans', () => {
  const toolsList = buildToolsList(TOOL_DEFINITIONS);
  
  // 1. Intent routing
  const intentDecision = decideTools({
    source: 'intent',
    prompt: 'build a 3D procedural horse simulator with three.js',
    list: toolsList
  });
  assert.ok(intentDecision.tools.includes('fs_write'));
  assert.ok(intentDecision.tools.includes('sysRun'));
  assert.ok(intentDecision.tools.includes('browser_act'));
  assert.ok(intentDecision.reasons.some(r => r.includes('web')));

  // 2. Plan text routing
  const planDecision = decideTools({
    source: 'plan',
    text: 'Step 1: Check git diff and inspect commit log with gitOp\nStep 2: blender_act render model',
    list: toolsList
  });
  assert.ok(planDecision.tools.includes('gitOp'));
  assert.ok(planDecision.tools.includes('blender_act'));

  // 3. Request routing (e.g. tool_search result)
  const reqDecision = decideTools({
    source: 'request',
    requested: ['archive', 'proc_term'],
    requestedPacks: ['system'],
    list: toolsList
  });
  assert.ok(reqDecision.tools.includes('archive'));
  assert.ok(reqDecision.tools.includes('proc_term'));
  assert.ok(reqDecision.packs.includes('system'));
});

test('smartToolsUse.refineToolDecision bounds admissions per step', () => {
  const toolsList = buildToolsList(TOOL_DEFINITIONS);
  const decision = decideTools({
    source: 'request',
    requested: [
      'archive', 'proc_term', 'desktop_act', 'ax_snapshot', 'clipboard',
      'printer_print', 'document_forge', 'blender_act', 'resolve_act', 'palmier_act'
    ],
    list: toolsList
  });

  const refined = refineToolDecision(decision, {
    planRequired: true,
    decisionRequired: false,
    admittedTools: new Set(),
    admittedPacks: new Set()
  });

  assert.equal(refined.route, 'plan');
  assert.ok(refined.tools.length <= 8);
  assert.ok(refined.deferred.length > 0);
});

test('saveTools manages tool admission order and persists session state', () => {
  const packs = new Set<string>();
  const tools = new Set<string>();
  const order: string[] = [];
  const saved = new SavedTools({ packs, tools, order });

  const result1 = saved.admit({
    source: 'intent',
    packs: ['web', 'media'],
    tools: ['fs_read', 'sysRun', 'browser_act'],
    reasons: ['initial intent']
  });
  assert.equal(result1.addedPacks.length, 2);
  assert.equal(result1.addedTools.length, 3);
  assert.deepEqual(order, ['web', 'media']);

  // Idempotent: duplicates are ignored in order
  const result2 = saved.admit({
    source: 'request',
    packs: ['web'],
    tools: ['fs_read', 'view_image'],
    reasons: ['request']
  });
  assert.equal(result2.addedPacks.length, 0);
  assert.equal(result2.addedTools.length, 1);
  assert.ok(tools.has('view_image'));

  // Persistence to disk
  const testSessionId = `test_session_${Date.now()}`;
  writeSavedTools(testSessionId, saved.toState());

  const restored = readSavedTools(testSessionId);
  assert.ok(restored);
  assert.deepEqual(restored?.packs, ['web', 'media']);
  assert.deepEqual(restored?.tools, ['fs_read', 'sysRun', 'browser_act', 'view_image']);

  // Cleanup test file
  const sessionFile = savedToolsPath(testSessionId);
  if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
});

test('verificationPlan.assessVerification detects missing evidence across domains', () => {
  // 1. Code mutation without verification command
  const codeAssessment = assessVerification({
    archetype: 'build_app',
    outcomes: [
      { tool: 'fs_write', path: 'src/index.ts', command: '', success: true, at: 1, error: '', exitCode: 0 }
    ]
  });
  assert.ok(codeAssessment.gaps.length > 0);
  assert.equal(codeAssessment.gaps[0]?.domain, 'code');
  assert.match(codeAssessment.directive, /\[VERIFY\]/);
  assert.match(codeAssessment.directive, /code_verify_syntax/);

  // 2. Code mutation WITH verification command -> no gap
  const verifiedAssessment = assessVerification({
    archetype: 'build_app',
    outcomes: [
      { tool: 'fs_write', path: 'src/index.ts', command: '', success: true, at: 1, error: '', exitCode: 0 },
      { tool: 'sysRun', path: '', command: 'npm run typecheck:strict', success: true, exitCode: 0, at: 2, error: '' }
    ]
  });
  assert.equal(verifiedAssessment.gaps.length, 0);
  assert.equal(verifiedAssessment.directive, '');

  // 3. Creative mutation without visual probe
  const creativeAssessment = assessVerification({
    archetype: 'media_3d_generation',
    outcomes: [
      { tool: 'blender_act', path: 'model.blend', command: '', success: true, at: 1, error: '', exitCode: 0 }
    ]
  });
  assert.ok(creativeAssessment.gaps.length > 0);
  assert.equal(creativeAssessment.gaps[0]?.domain, 'creative');
  assert.match(creativeAssessment.directive, /view_image/);
});
