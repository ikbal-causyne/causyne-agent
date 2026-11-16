import test from 'node:test';
import assert from 'node:assert/strict';
import { assessVerification } from '../src/verificationPlan.js';

const mutation = (at, path = 'src/main.ts') => ({
  tool: 'fs_write', args: { path }, path,
  command: '', at, success: true, error: '', exitCode: null
});
const testRun = (at, exitCode, success = true) => ({
  tool: 'sysRun', args: { command: 'npm test' }, path: '',
  command: 'npm test', at, success, error: '', exitCode
});

test('non-zero process exit is not verification even if a wrapper marks tool success', () => {
  const broken = assessVerification({ outcomes: [mutation(1), testRun(2, 1, true)] });
  assert.deepEqual(broken.domains, ['code']);
  assert.deepEqual(broken.gaps.map(g => g.domain), ['code']);
  assert.match(broken.directive, /VERIFY/);
});

test('genuine successful tests after the last mutation satisfy only the applicable domain', () => {
  const good = assessVerification({ outcomes: [mutation(1), testRun(2, 0, true)] });
  assert.deepEqual(good.gaps, []);
  assert.equal(good.directive, '');
  const stale = assessVerification({ outcomes: [mutation(1), testRun(2, 0), mutation(3)] });
  assert.deepEqual(stale.gaps.map(g => g.domain), ['code']);
});

test('unknown or failed mutations do not manufacture verification requirements', () => {
  const result = assessVerification({ outcomes: [
    { ...mutation(1), success: false }, testRun(2, 0)
  ] });
  assert.deepEqual(result.domains, []);
});
