---
name: safe-migrations
description: Change a production database schema. Use before any ALTER on a live table, when a migration might lock, or when a deploy includes a schema change.
---

# Safe Migrations

## The two rules

1. Every migration must be safe while the OLD code is still running, because during a deploy it is.
2. Nothing may hold a long lock on a table that is serving traffic.

## The operations that lock, and their safe form

- **Add a column with a default** — safe on modern PostgreSQL; on older versions it rewrites the table. Add nullable, backfill in batches, then set the default.
- **Add NOT NULL** — add a CHECK constraint as NOT VALID, validate it separately, then convert. The direct form scans the whole table under an exclusive lock.
- **Add an index** — always CONCURRENTLY. The plain form blocks writes for the duration.
- **Rename a column** — never in one step. Add the new one, write to both, migrate readers, then drop.
- **Change a type** — usually a rewrite. Add a new column, backfill, switch, drop.
- **Add a foreign key** — add NOT VALID, then validate separately.

## Workflow

1. Classify the migration as additive or destructive.
   - **Done when:** every statement is labelled, and no destructive statement ships alongside the code that stops using it.

2. Set a lock timeout before the statement.
   - `SET lock_timeout = '3s'`. Without it, a migration waiting on a lock queues every subsequent query behind it and takes the site down — the lock queue, not the migration, is what causes the outage.
   - **Done when:** every migration sets a lock timeout and fails fast rather than queueing.

3. Backfill in batches, outside the migration.
   - A single UPDATE over millions of rows holds a long transaction and bloats the table. Batch with a delay, as a job.
   - **Done when:** no migration updates an unbounded number of rows in one statement.

4. Test on a copy with production-scale data.
   - A migration that takes 3ms on a hundred rows can take twenty minutes on fifty million. Only a realistic copy tells you which.
   - **Done when:** the migration has been timed against production-scale data.

5. Write the reversal.
   - Additive migrations reverse cleanly. Destructive ones cannot — which is why they ship last, separately, after the new path is proven.
   - **Done when:** every migration has a tested down path, or is explicitly marked irreversible and shipped alone.

## Verification

- Timed against a production-scale copy.
- Applied against a running old-code instance with no errors.
- Lock timeout set; the migration fails rather than queueing.
