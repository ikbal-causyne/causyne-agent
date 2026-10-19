// Monetization Move 1 — capability gating scaffolding.
//
// These lock two contracts: (1) while the gate is DORMANT it must never restrict
// anyone (pre-release development and the current published app keep working),
// and (2) the tier→capability matrix ranks the way the docs promise, so flipping
// the flag at launch gates exactly the intended plans.

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  CAPABILITY_GATING_ENABLED,
  CAPABILITY_MIN_RANK,
  TIER_RANK,
  isCapabilityAllowed,
} from '../src/capabilities.js';

describe('capability gating (dormant scaffolding)', () => {
  test('ships dormant so nothing is restricted pre-launch', () => {
    assert.strictEqual(CAPABILITY_GATING_ENABLED, false);
    for (const tier of ['free', 'fast', 'premium', 'max', 'super_max']) {
      for (const cap of Object.keys(CAPABILITY_MIN_RANK)) {
        assert.strictEqual(isCapabilityAllowed(tier, cap), true,
          `${tier} should reach ${cap} while the gate is dormant`);
      }
    }
  });

  test('an unknown capability is never gated', () => {
    assert.strictEqual(isCapabilityAllowed('free', 'no_such_capability'), true);
  });

  test('the matrix ranks capabilities as documented', () => {
    assert.strictEqual(CAPABILITY_MIN_RANK.cortex_memory, TIER_RANK.premium);
    assert.strictEqual(CAPABILITY_MIN_RANK.tool_forge, TIER_RANK.max);
    // premium outranks fast; super_max outranks max.
    assert.ok(TIER_RANK.premium > TIER_RANK.fast);
    assert.ok(TIER_RANK.super_max > TIER_RANK.max);
  });
});
