---
name: backup-and-recovery
description: Set up or verify database backups. Use when a system has no tested restore, before a risky migration, or when planning for data loss.
---

# Backup and Recovery

## The only thing that counts

A backup that has never been restored is not a backup. It is an untested hypothesis with a storage bill. The restore is the deliverable.

## Workflow

1. State the two numbers first.
   - Recovery point objective: how much data may be lost. Recovery time objective: how long recovery may take. Everything else follows from these, and without them the design is arbitrary.
   - **Done when:** both numbers are written down and agreed.

2. Choose the mechanism to meet them.
   - Nightly dump: hours of potential loss, simple. Continuous archiving with point-in-time recovery: seconds of loss, more moving parts. A replica is high availability, NOT a backup — it replicates the bad DELETE faithfully and instantly.
   - **Done when:** the mechanism demonstrably meets both numbers.

3. Store copies where a single failure cannot reach them.
   - A different region and a different credential. Ransomware and a compromised account both reach anything the production credential can write, which is why immutable or write-once storage matters.
   - **Done when:** a compromised production credential cannot delete the backups.

4. Restore on a schedule, into a real environment.
   - Automate it, time it, and check row counts and a few known records. Do this monthly at minimum.
   - **Done when:** a restore has been performed and timed within the last month.

5. Back up more than the rows.
   - Schema, roles and grants, extensions, sequence positions, and any encryption keys. A restored database nobody can log into is not recovered.
   - **Done when:** a restore into an empty instance produces a working system with no manual steps.

6. Write the runbook.
   - Exact commands, in order, for someone who did not build the system, under pressure, possibly at night.
   - **Done when:** someone else has followed the runbook successfully without help.

## Verification

- A restore into a clean environment has been performed and timed.
- The restore time meets the recovery time objective.
- The data loss window meets the recovery point objective.
- Someone other than the author has run the runbook.
