import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CausyneLoopGuard, isContextOverflowError } from '../src/providers/loopGuard.js';

describe('CausyneLoopGuard', () => {
  it('allows actions within the threshold', () => {
    const guard = new CausyneLoopGuard({ maxEvents: 3, windowMs: 10_000, cooldownMs: 30_000 });
    assert.equal(guard.recordAction().allowed, true);
    assert.equal(guard.recordAction().allowed, true);
    assert.equal(guard.recordAction().allowed, true);
  });

  it('enforces cooldown when maxEvents is exceeded in window', () => {
    const guard = new CausyneLoopGuard({ maxEvents: 2, windowMs: 10_000, cooldownMs: 30_000 });
    assert.equal(guard.recordAction().allowed, true);
    assert.equal(guard.recordAction().allowed, true);
    
    // 3rd action trips the limit
    const tripped = guard.recordAction();
    assert.equal(tripped.allowed, false);
    assert.match(tripped.reason || '', /LoopGuard threshold tripped/);
    assert.ok((tripped.waitSeconds ?? 0) > 0);

    // Subsequent action is blocked while in cooldown
    const duringCooldown = guard.recordAction();
    assert.equal(duringCooldown.allowed, false);
    assert.match(duringCooldown.reason || '', /LoopGuard cooldown active/);
  });

  it('resets correctly', () => {
    const guard = new CausyneLoopGuard({ maxEvents: 1, windowMs: 10_000, cooldownMs: 30_000 });
    guard.recordAction();
    guard.recordAction(); // tripped
    assert.equal(guard.recordAction().allowed, false);
    
    guard.reset();
    assert.equal(guard.recordAction().allowed, true);
  });
});

describe('isContextOverflowError', () => {
  it('identifies genuine context overflow errors', () => {
    assert.equal(isContextOverflowError('Error: 400 Request entity too large (context full)'), true);
    assert.equal(isContextOverflowError('The prompt is too long for this model tier'), true);
    assert.equal(isContextOverflowError('Token limit exceeded: requested 150000 tokens'), true);
    assert.equal(isContextOverflowError('String too long for context window'), true);
  });

  it('does not false-positive on authentication or generic errors', () => {
    assert.equal(isContextOverflowError('Invalid API token provided: sk-proj-...'), false);
    assert.equal(isContextOverflowError('Bearer token expired'), false);
    assert.equal(isContextOverflowError('HTTP 404 Not Found'), false);
    assert.equal(isContextOverflowError(null), false);
    assert.equal(isContextOverflowError(undefined), false);
  });
});
