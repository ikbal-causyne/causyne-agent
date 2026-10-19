---
name: multi-region-and-failover
description: Design for regional failure or high availability. Use when planning for an outage, when latency varies by geography, or when a single region is a single point of failure.
---

# Multi-Region and Failover

## Be honest about the cost

Multi-region multiplies infrastructure cost and operational complexity, and introduces data consistency problems that do not exist in one region. Most systems should first make one region genuinely resilient — multiple availability zones, tested backups, tested restore. Reach for multi-region when the requirement demands it, not by default.

## Workflow

1. State the requirement in numbers.
   - How much data may be lost, how long recovery may take, and what an hour of downtime costs. These decide whether the complexity is justified.
   - **Done when:** the recovery objectives and the cost of downtime are written down.

2. Choose the posture deliberately.
   - Backup and restore: cheapest, hours to recover. Warm standby: minutes, moderate cost. Active-active: seconds, highest cost and hardest consistency.
   - **Done when:** the posture is chosen against the stated numbers.

3. Solve the data problem first.
   - This is the hard part, and everything else is easy by comparison. Asynchronous replication means a failover loses the replication lag. Synchronous costs latency on every write. Active-active means conflicts, and you must define the resolution rule.
   - **Done when:** the replication mode and its data-loss window are stated.

4. Make failover a routine, tested operation.
   - Automate it, document it, and rehearse it on a schedule. An untested failover fails when it is needed — that is the observed pattern, not a caution.
   - **Done when:** a failover has been performed in a rehearsal within the last quarter.

5. Do not forget what is regional but invisible.
   - Certificates, secrets, DNS records, container registries, queues, and scheduled jobs. Failover fails on the one dependency nobody listed.
   - **Done when:** every regional dependency has a plan.

6. Plan the failback.
   - Returning to the primary region requires reconciling data written to the secondary. This is frequently harder than the failover and is usually not planned.
   - **Done when:** failback has been rehearsed and its data reconciliation is defined.

## Verification

- Recovery objectives are stated and the posture meets them.
- A failover rehearsal has been performed and timed.
- Every regional dependency is inventoried.
- Failback has been rehearsed.
