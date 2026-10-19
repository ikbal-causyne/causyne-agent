// Capability gating (monetization Move 1) — DORMANT scaffolding.
//
// The agent is BYOK, so inference costs the owner nothing; the value a
// subscription buys is a *better body*, not more tokens. This module maps local
// capabilities to the minimum tier that unlocks them.
//
// It is deliberately INERT until launch: while CAPABILITY_GATING_ENABLED is
// false, isCapabilityAllowed() returns true for everyone, so pre-release
// development behaves exactly as before. At launch, flip the flag and call
// isCapabilityAllowed(tier, cap) at each local feature entry point.

export const CAPABILITY_GATING_ENABLED = false;

// Tiers rank so a higher plan is a superset of a lower one.
export const TIER_RANK = {
  starter: 0, free: 0, fast: 1,
  premium: 2, premium_annual: 2,
  max: 3, super_max: 4,
};

// Minimum tier rank required for each gated capability.
export const CAPABILITY_MIN_RANK = {
  cortex_memory:     TIER_RANK.premium, // V5 persistent memory across sessions
  tool_forge:        TIER_RANK.max,     // self-evolving runtime tool creation
};

/**
 * Whether `tier` unlocks `capability`. Returns true for everything while the
 * gate is dormant, and for any capability not present in the matrix.
 */
export function isCapabilityAllowed(tier, capability) {
  if (!CAPABILITY_GATING_ENABLED) return true;
  const need = CAPABILITY_MIN_RANK[capability];
  if (need == null) return true;
  return (TIER_RANK[tier] ?? 0) >= need;
}
