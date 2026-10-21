import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assessDecisionRequirement,
  isMutatingToolCall,
  requiresImplementationPlan
} from '../src/decisionPolicy.js';
import { normalizePlanUpdate } from '../src/implementationPlan.js';
import { requestDecision } from '../src/tools/requestDecision.js';
import { updatePlan } from '../src/tools/updatePlan.js';
import { DecisionLayer } from '../src/tui/dialogs.js';
import { AgentLoop } from '../src/agentLoop.js';

const REQUEST = {
  id: 'architecture-runtime',
  kind: 'architecture',
  header: 'Runtime choice',
  question: 'Which runtime should this subsystem use?',
  reason: 'The choice changes packaging and maintenance.',
  options: [
    { id: 'node', label: 'Node.js', description: 'Use the existing runtime.' },
    { id: 'rust', label: 'Rust', description: 'Introduce a native runtime.' }
  ],
  allowCustom: true
};

describe('durable decision policy', () => {
  test('requires a choice for an unresolved architecture alternative', () => {
    const result = assessDecisionRequirement('Should we use TypeScript or Rust for the runtime architecture?');
    assert.equal(result.required, true);
    assert.equal(result.kind, 'architecture');
  });

  test('respects a direct user architecture choice', () => {
    assert.equal(assessDecisionRequirement('We decided to use TypeScript for the runtime migration.').required, false);
    assert.equal(assessDecisionRequirement('Use TypeScript for this migration.').required, false);
    assert.equal(assessDecisionRequirement('Change the database schema to add a last_seen column.').required, false);
  });

  test('requires plans for complex builds without treating reads as mutations', () => {
    assert.equal(requiresImplementationPlan('Integrate a plugin system', 'integrate', 'medium'), true);
    assert.equal(isMutatingToolCall('fs_write', { path: 'x.ts' }), true);
    assert.equal(isMutatingToolCall('sysRun', { command: 'git status --short' }), false);
  });

  test('Mode C cannot bypass unresolved architecture or plan checkpoints', () => {
    const loop = {
      config: { autonomyMode: 'C' },
      _decisionRequirement: { required: true },
      _decisionResolved: false,
      _implementationPlanRequired: true,
      _implementationPlan: []
    };
    const checkpoint = AgentLoop.prototype.mutationCheckpoint.bind(loop);
    assert.match(checkpoint('fs_write', { path: 'x.ts' }), /ARCHITECTURE_DECISION_REQUIRED/);

    loop._decisionResolved = true;
    assert.match(checkpoint('fs_write', { path: 'x.ts' }), /IMPLEMENTATION_PLAN_REQUIRED/);

    loop._implementationPlan = [{ id: 'write', step: 'Write the module', status: 'in_progress' }];
    assert.equal(checkpoint('fs_write', { path: 'x.ts' }), null);
    assert.equal(checkpoint('fs_read', { path: 'x.ts' }), null);
  });
});

describe('implementation plan contract', () => {
  test('accepts one active step and reports it to the active loop', async () => {
    let received = null;
    const result = await updatePlan.execute({
      explanation: 'Begin with the contract.',
      plan: [
        { id: 'contract', step: 'Define the contract', status: 'in_progress' },
        { id: 'wire', step: 'Wire the runtime', status: 'pending' }
      ]
    }, { parentLoop: { updateImplementationPlan: update => { received = update; } } });

    assert.equal(result.success, true);
    assert.equal(received.plan[0].status, 'in_progress');
    assert.match(result.output, /0\/2 completed/);
  });

  test('rejects multiple active steps', () => {
    assert.throws(() => normalizePlanUpdate({ plan: [
      { id: 'one', step: 'First', status: 'in_progress' },
      { id: 'two', step: 'Second', status: 'in_progress' }
    ] }), /Only one plan step/);
  });
});

describe('structured decision interaction', () => {
  test('passes normalized choices to the loop', async () => {
    let captured = null;
    const result = await requestDecision.execute({
      kind: REQUEST.kind,
      header: REQUEST.header,
      question: REQUEST.question,
      reason: REQUEST.reason,
      options: REQUEST.options
    }, {
      parentLoop: {
        requestDecision: async request => {
          captured = request;
          return { requestId: request.id, optionId: 'node', label: 'Node.js', custom: false };
        }
      }
    });

    assert.equal(result.success, true);
    assert.equal(captured.allowCustom, true);
    assert.equal(captured.options.length, 2);
    assert.equal(result.decision.optionId, 'node');
  });

  test('supports keyboard selection and a custom answer', () => {
    let selected = null;
    const choice = new DecisionLayer({ request: REQUEST, onAnswer: answer => { selected = answer; } });
    assert.equal(choice.key({ name: 'down' }), 'handled');
    assert.equal(choice.key({ name: 'enter' }), 'close');
    assert.equal(selected.optionId, 'rust');

    let custom = null;
    const layer = new DecisionLayer({ request: REQUEST, onAnswer: answer => { custom = answer; } });
    layer.key({ name: 'down' });
    layer.key({ name: 'down' });
    assert.equal(layer.key({ name: 'enter' }), 'handled');
    layer.key({ name: 'paste', text: 'Use a WASI component' });
    assert.equal(layer.key({ name: 'enter' }), 'close');
    assert.deepEqual(custom, {
      requestId: REQUEST.id,
      optionId: null,
      label: 'Use a WASI component',
      custom: true
    });
  });

  test('dismissal is explicit and safe', () => {
    let answer = 'unset';
    const layer = new DecisionLayer({ request: REQUEST, onAnswer: value => { answer = value; } });
    assert.equal(layer.key({ name: 'escape' }), 'close');
    assert.equal(answer, null);
  });
});
