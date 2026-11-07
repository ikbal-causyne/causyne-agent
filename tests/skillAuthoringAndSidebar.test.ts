import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { sessionSidebarRows } from '../src/tui/sessionSidebar.js';
import { handleInput } from '../src/commands.js';
import { runInteractiveSkillWizard } from '../src/tui/skillAuthoring.js';

describe('Sidebar Active Skills Integration', () => {
  test('sessionSidebarRows: renders Active Skill section when activeSkill object is provided', () => {
    const facts = {
      title: 'Project Alpha',
      cwd: '/workspace/project',
      provider: 'antigravity',
      model: 'gemini-3.8-flash',
      activeSkill: {
        id: 'android/android-play-store-release',
        domain: 'android',
        name: 'android-play-store-release',
        description: 'Automated bundle validation, signing, and Play Store release workflow.'
      }
    };

    const rows = sessionSidebarRows(facts, 25);
    const text = rows.join('\n');
    assert.ok(text.includes('Active Skill'), 'Sidebar must render "Active Skill" header');
    assert.ok(text.includes('android/android-play-store-release'), 'Sidebar must render active skill ID');
    assert.ok(text.includes('Automated bundle validation'), 'Sidebar must render active skill description');
  });

  test('sessionSidebarRows: renders Active Skill when activeSkill is provided as a string', () => {
    const facts = {
      title: 'Project Beta',
      activeSkill: 'engineering/pr-review'
    };

    const rows = sessionSidebarRows(facts, 20);
    const text = rows.join('\n');
    assert.ok(text.includes('Active Skill'), 'Sidebar must render "Active Skill" header');
    assert.ok(text.includes('engineering/pr-review'), 'Sidebar must render string skill ID');
  });

  test('sessionSidebarRows: omits Active Skill section when activeSkill is null or unset', () => {
    const facts = {
      title: 'Project Gamma',
      activeSkill: null
    };

    const rows = sessionSidebarRows(facts, 20);
    const text = rows.join('\n');
    assert.ok(!text.includes('Active Skill'), 'Sidebar must NOT render "Active Skill" when null');
  });
});

describe('Commands /skill and /skills integration', () => {
  test('/skill with no args returns create-skill effect', async () => {
    const result = await handleInput('/skill');
    assert.equal(result.ok, true);
    assert.equal(result.effect, 'create-skill', '/skill with no args must return create-skill effect');
  });

  test('/skill new with no target returns create-skill effect', async () => {
    const result = await handleInput('/skill new');
    assert.equal(result.ok, true);
    assert.equal(result.effect, 'create-skill', '/skill new without target must return create-skill effect');
  });

  test('/skill clear and /skills clear return clear-skill effect', async () => {
    const res1 = await handleInput('/skill clear');
    assert.equal(res1.ok, true);
    assert.equal(res1.effect, 'clear-skill');

    const res2 = await handleInput('/skills clear');
    assert.equal(res2.ok, true);
    assert.equal(res2.effect, 'clear-skill');

    const res3 = await handleInput('/skills off');
    assert.equal(res3.ok, true);
    assert.equal(res3.effect, 'clear-skill');
  });

  test('/skills with no args prepends "+ Create new skill..." item', async () => {
    const result = await handleInput('/skills');
    assert.equal(result.ok, true);
    assert.equal(result.effect, 'pick-skill');
    assert.ok(Array.isArray(result.items));
    assert.ok(result.items.length > 0);
    const firstItem = result.items[0];
    assert.equal(firstItem.id, 'create');
    assert.equal(firstItem.name, '+ Create new skill...');
    assert.equal(firstItem.isCreateAction, true);
  });
});

describe('Interactive Skill Authoring Wizard', () => {
  test('runInteractiveSkillWizard guides through domain, name, and description and creates skill', async () => {
    const openedLayers: any[] = [];
    const mockPrompt = {
      openLayer(layer: any) {
        openedLayers.push(layer);
        // Automatically simulate user answers based on layer title
        if (layer.title?.includes('category name')) {
          layer.onSubmit('testing');
        } else if (layer.title?.includes('category')) {
          // Select category '__other__' to test custom category input
          layer.onPick({ value: '__other__' });
        } else if (layer.title?.includes('name')) {
          layer.onSubmit('smoke-test-flow');
        } else if (layer.title?.includes('description')) {
          layer.onSubmit('Runs comprehensive smoke tests before release deployments.');
        }
      },
      showText() {}
    };

    const created = await runInteractiveSkillWizard(mockPrompt as any);
    assert.ok(created, 'Skill wizard must return created skill');
    assert.equal(created?.domain, 'testing');
    assert.equal(created?.id, 'smoke-test-flow');
    assert.equal(created?.name, 'smoke-test-flow');
    assert.equal(created?.description, 'Runs comprehensive smoke tests before release deployments.');
    assert.ok(created?.content.includes('smoke-test-flow'));
  });
});
