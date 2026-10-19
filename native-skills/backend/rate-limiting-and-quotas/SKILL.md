---
name: rate-limiting-and-quotas
description: Add rate limiting or usage quotas to a service. Use when an endpoint can be called without bound, when one client can degrade service for others, or when abuse is suspected.
---

# Rate Limiting and Quotas

## Workflow

1. Choose the dimension before the algorithm.
   - Per user for fairness, per address for anonymous abuse, per endpoint for cost control, and globally for capacity protection. Most services need several at once.
   - **Done when:** each limit names its dimension and the abuse it prevents.

2. Pick the algorithm to match the traffic.
   - Token bucket: allows bursts up to the bucket size, refills steadily. The right default for user-facing APIs.
   - Sliding window: smoother, no burst allowance, more storage.
   - Fixed window: cheapest, but allows double the limit across a boundary.
   - **Done when:** the choice is stated and the burst behaviour is acceptable.

3. Enforce where the state is shared.
   - Per-instance counters mean the effective limit is multiplied by the instance count. Use a shared store with an atomic increment.
   - **Done when:** scaling out does not change the effective limit.

4. Answer with the right status and headers.
   - 429, with `Retry-After` and the `RateLimit` headers. A limit a client cannot see is a limit they will hit repeatedly.
   - **Done when:** a limited response tells the client exactly when to retry.

5. Identify the client honestly.
   - Behind a proxy, the connecting address is the proxy. Read the forwarded header only from a trusted proxy — otherwise a client can spoof it and bypass the limit entirely.
   - **Done when:** the address is taken from a trusted hop and spoofing is tested.

6. Fail closed at the edge, open in the middle.
   - If the limiter store is down, an authentication endpoint should reject; an internal read path should allow. State which each one does.
   - **Done when:** the behaviour when the store is unavailable is decided per endpoint.

## Verification

- Exceeding the limit returns 429 with `Retry-After`.
- The limit holds when the service runs on several instances.
- A spoofed forwarded header does not raise the limit.
