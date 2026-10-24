import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isActionableTaskPrompt, isDirectGameTask } from '../src/agentLoop.js';

test('a Three.js game request does not require the full engine cascade', () => {
  assert.equal(isDirectGameTask('create a 3js shooting game and optimize it with numpy'), true);
  assert.equal(isDirectGameTask('build a Three.js game'), true);
  assert.equal(isDirectGameTask('build a Godot game'), false);
  assert.equal(isDirectGameTask('build a Three.js game inside Unity'), false);
});

test('a long information request is not treated as an unfulfilled file operation', () => {
  assert.equal(isActionableTaskPrompt('What is the difference between these two approaches?'), false);
  assert.equal(isActionableTaskPrompt('create a 3js shooting game'), true);
});
