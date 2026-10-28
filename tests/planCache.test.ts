import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractKeywords,
  similarity,
  toStep,
  renderPlanHint,
  recordPlan,
  lookupPlan,
  forgetPlans
} from '../src/core/planCache.js';

describe('core/planCache', () => {
  beforeEach(() => {
    forgetPlans();
  });

  it('extracts meaningful lowercase keywords without punctuation or stopwords', () => {
    const kw = extractKeywords('Please create a 3D red apple scene in Blender with meadow background');
    assert.ok(kw.includes('apple'));
    assert.ok(kw.includes('blender'));
    assert.ok(kw.includes('meadow'));
    assert.ok(kw.includes('scene'));
    assert.ok(!kw.includes('please'));
    assert.ok(!kw.includes('a'));
  });

  it('calculates Jaccard similarity accurately', () => {
    const setA = ['apple', 'blender', 'render', 'red'];
    const setB = ['apple', 'blender', 'cycles', 'meadow'];
    const sim = similarity(setA, setB);
    // Intersection: apple, blender (2)
    // Union: apple, blender, render, red, cycles, meadow (6)
    // 2 / 6 = 0.333...
    assert.ok(Math.abs(sim - (2 / 6)) < 0.01);
  });

  it('records a verified plan and retrieves it via lookupPlan', () => {
    const recorded = recordPlan({
      taskId: 'test_task_3d',
      prompt: 'render a realistic red apple in blender with rain drops',
      archetype: 'media_3d_generation',
      steps: [
        { tool: 'blender_act', note: 'create_scene', ok: true },
        { tool: 'blender_act', note: 'render_frame', ok: true }
      ],
      succeeded: true
    });

    assert.ok(recorded);
    assert.equal(recorded.archetype, 'media_3d_generation');

    const match = lookupPlan({
      prompt: 'create realistic apple in blender',
      archetype: 'media_3d_generation'
    });

    assert.ok(match);
    assert.equal(match.template.archetype, 'media_3d_generation');
    assert.ok(match.similarity >= 0.38);

    const hint = renderPlanHint(match);
    assert.match(hint, /PRIOR ART/);
    assert.match(hint, /blender_act/);
  });

  it('converts tool execution to lightweight plan step without storing full content', () => {
    const step = toStep('fs_write', { action: 'write', path: '/tmp/test.html', content: 'huge 50kb html...' }, true);
    assert.equal(step.tool, 'fs_write');
    assert.equal(step.note, 'write');
    assert.equal(step.ok, true);
    assert.ok(!('content' in (step as any)));
  });
});
