---
name: algorithmic-complexity
description: Fix code that slows down disproportionately as data grows. Use when performance is fine in testing and bad in production, or when a loop contains a lookup.
---

# Algorithmic Complexity

## Where the real wins are

Constant-factor optimisation buys a few percent. Removing a factor of n buys orders of magnitude. On real data, the difference between a nested loop and a hash lookup dwarfs every micro-optimisation combined — and the nested loop is invisible on a test fixture of ten items.

## Workflow

1. Find the nested iteration.
   - A loop containing a search, a filter, an `includes`, or a query. This is the single most common cause of "fine in dev, unusable in production".
   - Fix: build a map or set once, then look up in constant time.
   - **Done when:** no loop body performs a linear search over another collection.

2. Look for repeated work that could be done once.
   - A value recomputed on every iteration, a regular expression compiled inside a loop, a sort inside a loop. Hoist it.
   - **Done when:** nothing invariant is computed inside a loop.

3. Choose the structure for the dominant operation.
   - Frequent membership tests: a set. Frequent lookup by key: a map. Ordered range queries: a sorted structure or an index. Using an array for membership testing is the same mistake as the nested loop.
   - **Done when:** the data structure matches the most frequent operation.

4. Push filtering to where the data lives.
   - Fetching ten thousand rows to keep five is ten thousand rows of transfer, allocation and parsing. Filter in the query.
   - **Done when:** the volume fetched is proportional to the volume used.

5. Do not process what you will not show.
   - Paginate, limit, and stream. A list endpoint with no limit is unbounded work triggered by a stranger.
   - **Done when:** every collection operation has a bound.

6. Verify the complexity empirically.
   - Time with n, 10n and 100n. Linear growth is fine; quadratic shows up immediately at 100n.
   - **Done when:** timing scales as the intended complexity predicts.

## Verification

- Timing at three input sizes matches the intended complexity.
- No loop body contains a linear search.
- Every collection endpoint is bounded.
