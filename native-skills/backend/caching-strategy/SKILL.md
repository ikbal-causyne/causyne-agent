---
name: caching-strategy
description: Add or fix caching. Use when a cache serves stale data, when a cache miss storm overloads a database, or when caching is being introduced to fix a slow endpoint.
---

# Caching Strategy

## Before adding a cache

A cache is a correctness risk taken deliberately in exchange for speed. Confirm the slowness is real, measured, and not a missing index — an index fixes the cause; a cache hides it and adds a staleness bug.

## Workflow

1. Decide the invalidation before the caching.
   - Time-based expiry: simple, and the staleness window must be acceptable to the product, not just to you.
   - Event-based: invalidate on write. Correct, and every write path must remember. One that forgets is a bug that only appears in production.
   - **Done when:** the invalidation rule is written down and every write path honours it.

2. Build the key deliberately.
   - Include everything the value depends on: identifier, version, locale, and the viewer's permissions. A cache key missing the permission dimension serves one user's data to another. This is the most damaging caching bug and it is common.
   - **Done when:** two users with different permissions cannot share a key.

3. Prevent the stampede.
   - When a hot key expires, every concurrent request misses and hits the origin at once. Use a lock so one request refills while others serve the stale value, or refresh ahead of expiry.
   - **Done when:** expiring a hot key under load produces one origin call, not many.

4. Cache negatives too, briefly.
   - A missing record queried repeatedly bypasses the cache entirely. Cache the absence with a short expiry.
   - **Done when:** repeated lookups of a nonexistent key do not reach the origin each time.

5. Fail open.
   - If the cache is unreachable the application serves from the origin, more slowly. A cache outage must not be an application outage.
   - **Done when:** stopping the cache leaves the application working.

6. Measure the hit rate.
   - A cache below roughly 80% hit rate is usually keyed wrongly or expiring too fast, and is adding complexity for little gain.
   - **Done when:** the hit rate is instrumented and reported.

## Verification

- Hit rate is measured and reported.
- Stopping the cache degrades performance without breaking correctness.
- A write invalidates every affected key, verified by test.
- Two users with different permissions receive different data.
