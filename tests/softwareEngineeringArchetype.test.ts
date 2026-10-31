import test from 'node:test';
import assert from 'node:assert/strict';
import { determineToolScope } from '../src/smartToolsUse.js';
import { turnTokenLimitFor, actionLimitFor, tokenLimitFor } from '../src/providers/budgetEnforcer.js';

test('Software Engineering archetype classifies all backend, API, systems, and refactoring tasks', () => {
  const prompts = [
    'Refactor the authentication architecture across the entire repository and add end-to-end tests',
    'Build a high-performance distributed streaming engine in C++',
    'Audit all memory leaks and race conditions in this backend codebase',
    'Write database schema migrations and integrate PostgreSQL',
    'Create a microservice in Go for image transcoding',
    'Implement a Redis caching layer for the REST API endpoints',
    'Debug why the worker queue dropped messages during failover',
    'Write a CLI tool in Rust for file encryption and hashing'
  ];

  for (const prompt of prompts) {
    const scope = determineToolScope(prompt);
    assert.equal(scope.archetype, 'software_engineering', `Prompt "${prompt}" must resolve to software_engineering`);
    assert.equal(turnTokenLimitFor(scope.archetype), 1_000_000, `Single-turn token limit for "${prompt}" must be 1,000,000`);
    assert.equal(actionLimitFor(scope.archetype), 200, `Action limit for "${prompt}" must be 200`);
    assert.equal(tokenLimitFor(scope.archetype), 2_500_000, `Task token ceiling for "${prompt}" must be 2,500,000`);
    assert.ok(scope.toolScope?.has('fs_write'), 'Must preload fs_write');
    assert.ok(scope.toolScope?.has('fs_edit'), 'Must preload fs_edit');
    assert.ok(scope.toolScope?.has('sysRun'), 'Must preload sysRun');
  }
});
