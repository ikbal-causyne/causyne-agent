import { describe, test } from 'node:test';
import { adversarialRegex } from './helpers/adversarialRegexFixtures.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isPureSkillOrCapabilityLookup,
  redactSkillAndQueryLiterals,
  requiresImplementationPlan
} from '../src/decisionPolicy.js';
import { determineToolScope, filterSuppressedPacks } from '../src/smartToolsUse.js';
import { analyzeTask } from '../src/taskShape.js';
import { decideTools } from '../src/decideTools.js';
import { buildToolsList } from '../src/toolsList.js';
import { deferredMcpSearch } from '../src/tools/deferredMcpSearch.js';
import { normalizePaths, resolveParameterAliases, selfRepairToolCall } from '../src/tools/toolSelfRepair.js';
import { AgentLoop, extractSkillIdFromPrompt } from '../src/agentLoop.js';
import readNativeSkill from '../src/tools/readNativeSkill.js';
import { Sandbox } from '../src/sandbox.js';
import { writeUserSkill } from '../src/userSkills.js';
import { invalidateUserSkills } from '../src/skillsManager.js';

describe('Skill reading and capability lookup routing', () => {
  test('Test 3 prompt routes to skill_lookup/research without implementation plan and admits fs_read_skill', () => {
    for (const prompt of [
      'Read the skill mobile-development/android-build-optimization using fs_read_skill',
      'Read the skill mobile-development/android-build-optimization using fs_read_skil',
      'Load skill: `android/gradle-build-configuration`'
    ]) {
      assert.equal(isPureSkillOrCapabilityLookup(prompt), true, `Expected pure lookup for: ${prompt}`);

      const scope = determineToolScope(prompt);
      assert.equal(scope.archetype, 'skill_lookup');
      assert.ok(scope.toolScope?.has('fs_read_skill'));
      assert.ok(scope.toolScope?.has('tool_search'));
      assert.ok(scope.suppressedPacks.includes('reverse_engineering'));

      const shape = analyzeTask(prompt, {
        framework: 'React',
        projectType: 'web',
        designSystem: '',
        keyFiles: ['index.html', 'package.json']
      });
      assert.equal(shape.archetype, 'research');
      assert.equal(shape.packs.length, 0);
      assert.equal(requiresImplementationPlan(prompt, shape.archetype, shape.confidence), false);

      const decision = decideTools({
        source: 'intent',
        list: buildToolsList(),
        prompt,
        taskShape: shape
      });
      assert.ok(decision.tools.includes('fs_read_skill'));
      assert.ok(decision.tools.includes('tool_search'));
      assert.equal(decision.packs.length, 0);
    }
  });

  test('Test 1 prompt with ReDoS pattern and android regex literal stays in skill_lookup/research without build plan', () => {
    const prompt = 'Use tool_search to search for capabilities matching (a+)+$ and android/.*gradle';
    assert.equal(isPureSkillOrCapabilityLookup(prompt), true);

    const redacted = redactSkillAndQueryLiterals(prompt);
    assert.doesNotMatch(redacted, /android/);
    assert.doesNotMatch(redacted, /gradle/);

    const scope = determineToolScope(prompt);
    assert.equal(scope.archetype, 'skill_lookup');
    assert.ok(scope.toolScope?.has('tool_search'));

    const shape = analyzeTask(prompt);
    assert.equal(shape.archetype, 'research');
    assert.equal(shape.packs.length, 0);
    assert.equal(requiresImplementationPlan(prompt, shape.archetype, shape.confidence), false);
  });

  test('Skill inventory questions suppress reverse_engineering/media/web/game packs and keep fs_read_skill ready', () => {
    const prompt =
      'What skills do you have available for Android reverse engineering and database query optimization?';
    assert.equal(isPureSkillOrCapabilityLookup(prompt), true);

    const scope = determineToolScope(prompt);
    assert.equal(scope.archetype, 'skill_lookup');
    assert.ok(scope.suppressedPacks.includes('reverse_engineering'));

    const remaining = filterSuppressedPacks(['reverse_engineering', 'web', 'game', 'media'], prompt);
    assert.equal(remaining.size, 0);

    const shape = analyzeTask(prompt);
    assert.equal(shape.archetype, 'research');
    assert.equal(requiresImplementationPlan(prompt, shape.archetype, shape.confidence), false);

    const decision = decideTools({
      source: 'intent',
      list: buildToolsList(),
      prompt,
      taskShape: shape
    });
    assert.ok(decision.tools.includes('fs_read_skill'));
    assert.equal(decision.packs.length, 0);
  });

  test('Mixed skill + code edit prompts stay in software_engineering while still admitting fs_read_skill', () => {
    const prompt = 'Read the skill android/gradle-build-configuration and fix build.gradle';
    assert.equal(isPureSkillOrCapabilityLookup(prompt), false);

    const scope = determineToolScope(prompt);
    assert.equal(scope.archetype, 'software_engineering');

    const decision = decideTools({
      source: 'intent',
      list: buildToolsList(),
      prompt
    });
    assert.ok(decision.tools.includes('fs_read_skill'));
    assert.ok(decision.tools.includes('fs_edit'));
    assert.ok(decision.tools.includes('fs_read'));
  });

  test('Skill creation is not misclassified as read-only skill_lookup', () => {
    const prompt = 'Create a skill team/release-checklist for release verification';
    assert.equal(isPureSkillOrCapabilityLookup(prompt), false);
    assert.notEqual(determineToolScope(prompt).archetype, 'skill_lookup');
  });

  test('deferredMcpSearch unlocks fs_read_skill on skill hits, supports query aliases/arrays, and honors policy', async () => {
    const androidRes = await deferredMcpSearch.execute({ query: 'android gradle build optimization' });
    assert.equal(androidRes.success, true);
    assert.ok(androidRes._unlock_tools?.includes('fs_read_skill'));
    assert.match(androidRes.output || '', /Matching SKILLS/);

    const skillOnlyRes = await deferredMcpSearch.execute({ query: 'django migration structure' });
    assert.equal(skillOnlyRes.success, true);
    assert.ok(skillOnlyRes._unlock_tools?.includes('fs_read_skill'));

    // Policy omission of fs_read_skill from searchableTools prevents unauthorized unlock
    const restrictedRes = await deferredMcpSearch.execute(
      { query: 'android gradle build' },
      {
        parentLoop: {
          searchableTools: async () => [{ name: 'fs_read', description: 'Read a file' }]
        }
      }
    );
    assert.equal(restrictedRes.success, true);
    assert.equal(restrictedRes._unlock_tools?.includes('fs_read_skill') ?? false, false);

    // Array query and alias parameters ('queries', 'term', 'regex') work safely
    const qArrRes = await deferredMcpSearch.execute({ query: ['android', 'gradle'] } as any);
    assert.equal(qArrRes.success, true);
    assert.ok(qArrRes._unlock_tools?.includes('fs_read_skill'));

    const queriesRes = await deferredMcpSearch.execute({ queries: ['database', 'query'] } as any);
    assert.equal(queriesRes.success, true);

    const regexAliasRes = await deferredMcpSearch.execute({ regex: adversarialRegex.nestedPlus } as any);
    assert.equal(regexAliasRes.success, true);
  });

  test('extractSkillIdFromPrompt, toolSelfRepair aliases, and validateToolArgs handle skill & search edge cases', () => {
    assert.equal(
      extractSkillIdFromPrompt(
        'Read the skill mobile-development/android-build-optimization using fs_read_skill'
      ),
      'mobile-development/android-build-optimization'
    );
    assert.equal(
      extractSkillIdFromPrompt('Load skill: `android/gradle-build-configuration`'),
      'android/gradle-build-configuration'
    );
    assert.equal(extractSkillIdFromPrompt('Read the skill using fs_read_skill'), '');

    const rgAlias = resolveParameterAliases('code_search_ripgrep', { path: 'src', regex: 'needle' });
    assert.equal(rgAlias.args.searchPath, 'src');
    assert.equal(rgAlias.args.query, 'needle');

    // Unrelated tools without schema should not synthesize searchPath or skill_id
    const readAlias = resolveParameterAliases('fs_read', { path: 'src/a.ts' });
    assert.equal('searchPath' in readAlias.args, false);
    assert.equal('skill_id' in readAlias.args, false);

    const skillAlias = resolveParameterAliases('fs_read_skill', { name: 'android/android-cli' });
    assert.equal(skillAlias.args.skill_id, 'android/android-cli');

    const wsRoot = path.resolve(os.tmpdir(), 'sample-ws');
    const norm = normalizePaths(
      { searchPath: 'src', target: 'desktop', target_directories: ['tests'] },
      wsRoot,
      { properties: { target: { type: 'string', enum: ['desktop', 'window'] } } }
    );
    assert.equal(norm.args.searchPath, path.join(wsRoot, 'src'));
    assert.equal(norm.args.target, 'desktop');
    assert.deepEqual(norm.args.target_directories, [path.join(wsRoot, 'tests')]);

    const validate = (name: string, args: unknown) =>
      AgentLoop.prototype.validateToolArgs.call({ workspaceRoot: wsRoot }, name, args);

    assert.match(validate('fs_read_skill', {}) || '', /skill_id/);
    assert.equal(validate('fs_read_skill', { skill_id: 'android/android-cli' }), null);
    assert.equal(validate('tool_search', { query: ['android', 'gradle'] }), null);

    const visionArgs = { target: 'desktop', question: 'Check UI' };
    assert.equal(validate('vision_inspect_ui', visionArgs), null);
    assert.equal(visionArgs.target, 'desktop');

    const cbArgs = { query: 'test', target_directories: ['src'] };
    assert.equal(validate('codebase_search', cbArgs), null);
    assert.deepEqual(cbArgs.target_directories, [path.join(wsRoot, 'src')]);
  });

  test('deferredMcpSearch precision: ReDoS-shaped and multi-word queries exclude unrelated game tools and false skills', async () => {
    const t0 = Date.now();
    const result = await deferredMcpSearch.execute({ query: adversarialRegex.nestedPlus + ' and android/.*gradle' });
    const duration = Date.now() - t0;
    assert.ok(duration < 1000, `ReDoS search must complete quickly without freezing: ${duration}ms`);
    assert.equal(result.success, true);
    assert.ok(result._unlock_tools?.includes('fs_read_skill'));

    const unlocked = result._unlock_tools || [];
    const forbiddenTools = [
      'godot_act', 'game_build_html5', 'game_scene_build', 'game_lore_forge',
      'game_quest_arc_builder', 'game_animation_rig', 'game_ai_behavior_tree',
      'game_asset_harvest', 'game_entity_spawner', 'game_economy_balancer',
      'game_ui_hud_builder'
    ];
    for (const tool of forbiddenTools) {
      assert.equal(unlocked.includes(tool), false, `Tool ${tool} must not be unlocked for android gradle query`);
    }

    assert.match(result.output || '', /android\/gradle-build-configuration/);
    assert.match(result.output || '', /android\/agp-9-upgrade/);
  });

  test('readNativeSkill suggestions: unknown skill provides close matches without noisy domain bleeding', async () => {
    const res = await readNativeSkill.execute({ skill_id: 'mobile-development/android-build-optimization' });
    assert.equal(res.success, false);
    assert.match(res.error || '', /Did you mean:.*android\/gradle-build-configuration/);
    assert.match(res.error || '', /Did you mean:.*mobile\/app-startup-optimisation/);
    assert.doesNotMatch(res.error || '', /docker-multi-stage-builds/);
  });

  test('fs_read_skill preserves relative resource paths and traversal attempts, while Sandbox admits external user-skills', async () => {
    const wsRoot = path.resolve(os.tmpdir(), 'causyne-sandbox-ws');
    const relativeResourceCall = {
      function: {
        name: 'fs_read_skill',
        arguments: JSON.stringify({ skill_id: 'team/release-checklist', file_path: 'references/guide.md' })
      }
    };
    const repaired = selfRepairToolCall(relativeResourceCall, readNativeSkill.schema.parameters, { cwd: wsRoot });
    assert.equal(repaired.args.file_path, 'references/guide.md', 'Relative skill resource path must not resolve against cwd');

    const attackCall = {
      function: {
        name: 'fs_read_skill',
        arguments: JSON.stringify({ skill_id: 'android/gradle-build-configuration', file_path: '../../.ssh/id_rsa' })
      }
    };
    const repairedAttack = selfRepairToolCall(attackCall, readNativeSkill.schema.parameters, { cwd: wsRoot });
    assert.equal(repairedAttack.args.file_path, '../../.ssh/id_rsa', 'Traversal string must not be altered into absolute root path');

    const validate = (name: string, args: unknown) =>
      AgentLoop.prototype.validateToolArgs.call({ workspaceRoot: wsRoot }, name, args);
    const loopArgs = { skill_id: 'team/release-checklist', file_path: 'references/guide.md' };
    assert.equal(validate('fs_read_skill', loopArgs), null);
    assert.equal(loopArgs.file_path, 'references/guide.md');

    const sandbox = new Sandbox({ workspaceRoot: wsRoot });
    const sbDecision = sandbox.validate('fs_read_skill', {
      skill_id: 'team/release-checklist',
      file_path: 'references/guide.md'
    });
    assert.equal(sbDecision.allowed, true, 'fs_read_skill resources outside workspace must be governed by skill safety, not workspace check');

    // End-to-end user skill read with supporting resource in CAUSYNE_HOME
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-skill-e2e-'));
    const prevHome = process.env.CAUSYNE_HOME;
    process.env.CAUSYNE_HOME = tmpHome;
    invalidateUserSkills();
    try {
      const skillRoot = path.join(tmpHome, 'skills');
      writeUserSkill({
        domain: 'team',
        name: 'release',
        content: '---\nname: release\ndescription: Release checklist\n---\n# Release\n1. Verify.\n   - **Done when:** ok.\n## Verification\n- verify\n'
      }, skillRoot);
      const refDir = path.join(skillRoot, 'team', 'release', 'references');
      fs.mkdirSync(refDir, { recursive: true });
      fs.writeFileSync(path.join(refDir, 'guide.md'), '# Verified Guide\nFollow checklist.');

      const readSkillRes = await readNativeSkill.execute({ skill_id: 'team/release' });
      assert.equal(readSkillRes.success, true);
      assert.match(readSkillRes.result || '', /references\/guide\.md/);

      const readResRes = await readNativeSkill.execute({ skill_id: 'team/release', file_path: 'references/guide.md' });
      assert.equal(readResRes.success, true);
      assert.match(readResRes.result || '', /# Verified Guide/);

      const attackRes = await readNativeSkill.execute({ skill_id: 'team/release', file_path: '../../.ssh/id_rsa' });
      assert.equal(attackRes.success, false);
      assert.match(attackRes.error || '', /Resource not listed or not accessible/);
    } finally {
      if (prevHome === undefined) delete process.env.CAUSYNE_HOME;
      else process.env.CAUSYNE_HOME = prevHome;
      invalidateUserSkills();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
