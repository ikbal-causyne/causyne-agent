---
name: query-optimisation
description: Make a slow database query fast. Use when an endpoint is slow, when a query times out, or when the database shows high CPU.
---

# Query Optimisation

## Workflow

1. Read the actual plan, not the estimated one.
   - `EXPLAIN ANALYZE` runs the query and reports what really happened. The estimate can be wildly wrong, and the difference between estimate and actual is itself the most useful diagnostic — it means the statistics are stale.
   - **Done when:** you have a real plan with actual row counts and timings.

2. Find the expensive node.
   - Look for a sequential scan on a large table, a nested loop over many rows, or a sort that spills to disk. One node usually dominates.
   - **Done when:** you can name the node consuming most of the time.

3. Index what is filtered, joined and ordered.
   - A composite index's column order matters: equality columns first, then the range or sort column. An index the planner will not use is usually in the wrong order, or the column is wrapped in a function.
   - **Done when:** the plan shows an index scan and the timing has dropped.

4. Fix the N+1 before optimising the one.
   - One query in a loop over a hundred rows is a hundred round trips. This is far more common than a genuinely slow query, and no index fixes it. Batch or join instead.
   - **Done when:** the request issues a bounded number of queries regardless of result size.

5. Select only what you use.
   - `SELECT *` prevents index-only scans and drags large columns across the wire. Name the columns.
   - **Done when:** no query in the hot path selects columns the caller ignores.

6. Confirm the statistics are current.
   - A plan that is wrong by orders of magnitude usually means stale statistics after a bulk load. Analyse the table and re-check before adding an index that was never needed.
   - **Done when:** estimated and actual row counts are within an order of magnitude.

## Verification

- Report the before and after timing from `EXPLAIN ANALYZE`.
- The plan shows the intended access path.
- The request issues a bounded number of queries.
