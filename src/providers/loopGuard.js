/**
 * @file src/providers/loopGuard.ts
 * Causyne Agent — Sliding-Window Loop Guard & Context Overflow Detector
 *
 * Ported & elevated from Hermes Agent (gateway/bot_loop_guard.py & gateway/run_turn.py).
 * Protects against conversational bounce-back, self-sustaining loops, and
 * accurately detects context overflow without false positives from auth tokens.
 *
 * Authorship: Strict TypeScript (Causyne Agent).
 */
const CONTEXT_OVERFLOW_PHRASES = [
    'request entity too large',
    'prompt is too long',
    'too many tokens',
    'context length exceeded',
    'maximum context length',
    'input is too long',
    'token limit exceeded',
    'exceeds model context window',
    'context window is full',
    'prompt token count exceeds',
    'string too long for context',
    'payload too large'
];
export class CausyneLoopGuard {
    timestamps = [];
    inCooldownUntil = 0;
    config;
    constructor(customConfig) {
        this.config = {
            maxEvents: customConfig?.maxEvents ?? 15,
            windowMs: customConfig?.windowMs ?? 120_000,
            cooldownMs: customConfig?.cooldownMs ?? 300_000
        };
    }
    recordAction() {
        const now = Date.now();
        if (now < this.inCooldownUntil) {
            const waitSeconds = Math.ceil((this.inCooldownUntil - now) / 1000);
            return {
                allowed: false,
                waitSeconds,
                reason: `LoopGuard cooldown active. Rate limit exceeded; wait ${waitSeconds}s before retrying.`
            };
        }
        // Prune events outside the sliding window
        this.timestamps = this.timestamps.filter(t => now - t <= this.config.windowMs);
        this.timestamps.push(now);
        if (this.timestamps.length > this.config.maxEvents) {
            this.inCooldownUntil = now + this.config.cooldownMs;
            const waitSeconds = Math.ceil(this.config.cooldownMs / 1000);
            return {
                allowed: false,
                waitSeconds,
                reason: `LoopGuard threshold tripped: ${this.timestamps.length} actions within ${Math.round(this.config.windowMs / 1000)}s window. Cooldown enforced for ${waitSeconds}s.`
            };
        }
        return { allowed: true };
    }
    reset() {
        this.timestamps = [];
        this.inCooldownUntil = 0;
    }
    getStatus() {
        const now = Date.now();
        const active = this.timestamps.filter(t => now - t <= this.config.windowMs).length;
        const remaining = Math.max(0, this.inCooldownUntil - now);
        return {
            activeEvents: active,
            inCooldown: remaining > 0,
            remainingCooldownMs: remaining
        };
    }
}
/**
 * Accurately classifies provider context overflow errors from stderr / error messages
 * without false positives from API authentication tokens or general 400 Bad Requests.
 */
export function isContextOverflowError(errorMessage) {
    if (!errorMessage || typeof errorMessage !== 'string')
        return false;
    const normalized = errorMessage.toLowerCase();
    return CONTEXT_OVERFLOW_PHRASES.some(phrase => normalized.includes(phrase));
}
