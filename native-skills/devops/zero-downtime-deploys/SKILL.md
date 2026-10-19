---
name: zero-downtime-deploys
description: Design or repair a deployment strategy. Use when a release causes a visible outage, when migrations and code ship together, or when rollback is untested.
---

# Zero-Downtime Deploys

## The rule that governs everything else

Old code and new code will run at the same time. Every change must be safe in that window, or the deploy is not zero-downtime regardless of the orchestration.

## Workflow

1. Classify the change.
   - Additive (new column, new endpoint, new field): safe to ship together.
   - Destructive (dropped column, renamed field, changed semantics): must be split across releases.
   - **Done when:** every change in the release is labelled additive or destructive.

2. Split every destructive change into the expand/contract sequence.
   - Release 1: add the new shape, write to both, read from the old.
   - Release 2: read from the new. Deploy, then verify.
   - Release 3: stop writing the old, then drop it.
   - **Done when:** no single release both writes and removes the same shape.

3. Make migrations independent of the deploy.
   - Migrations run before the new code and must be safe for the old code still serving traffic.
   - **Done when:** the migration can run with zero new instances started.

4. Verify rollback before you need it.
   - Roll back in a staging environment and confirm the previous version serves correctly against the migrated schema.
   - **Done when:** rollback has actually been executed once, not merely documented.

5. Drain connections on shutdown.
   - Handle the termination signal: stop accepting new work, finish in-flight work, then exit. A process that exits immediately drops live requests.
   - **Done when:** a rolling restart under load shows zero failed requests.

## Verification

- Run a rolling restart with a load generator active; error count stays at zero.
- Roll back one version with traffic flowing; error count stays at zero.
