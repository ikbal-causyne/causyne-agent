---
name: memory-and-leak-hunting
description: Diagnose growing memory or an out-of-memory failure. Use when a process grows over time, when it is killed by the platform, or when garbage collection pauses become long.
---

# Memory and Leak Hunting

## Growth versus leak

A leak is unbounded retention: memory that is reachable but never used again. High usage that plateaus is not a leak — it is a cache or a pool doing its job. Distinguish these before investigating, because they need opposite responses.

## Workflow

1. Establish the shape of the growth.
   - Plot resident memory over hours. Linear with traffic suggests per-request retention. Stepwise suggests a cache without a bound. A plateau is not a leak.
   - **Done when:** the growth pattern is characterised.

2. Take two heap snapshots and compare.
   - One after warm-up, one after a period of load, having returned to the same logical state. The DIFFERENCE is the leak; a single snapshot mostly shows normal working set.
   - **Done when:** you have the object types that grew between snapshots.

3. Follow the retaining path.
   - The profiler shows what holds the object. The answer is almost always one of: a module-level collection that only grows, a listener never removed, a closure capturing a large scope, a cache with no eviction, or a timer holding its context.
   - **Done when:** the retaining reference is named.

4. Bound every cache.
   - A map used as a cache with no maximum size and no eviction is the most common leak in any language. Give it a bound and a policy.
   - **Done when:** every long-lived collection has a maximum size.

5. Pair every registration with a removal.
   - Listeners, subscriptions, intervals, and observers. Where the language supports it, use a scope guard so the pairing cannot be forgotten.
   - **Done when:** every registration has a guaranteed removal.

6. Re-measure over the same window.
   - **Done when:** memory returns to baseline after load, over the duration that previously showed growth.

## Verification

- Memory plateaus rather than growing over a long soak test.
- The retained set returns to baseline after load stops.
- Every cache has a stated bound.
