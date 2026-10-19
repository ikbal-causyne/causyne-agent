---
name: cost-optimisation
description: Reduce cloud spend. Use when a bill grows unexpectedly, before scaling up, or during a cost review.
---

# Cloud Cost Optimisation

## Where the money usually is

Idle resources, oversized instances, data transfer, and storage nobody deleted. Rarely the thing people assume. Find out before acting.

## Workflow

1. Attribute the spend before changing anything.
   - Tag everything by team, environment and service, then break the bill down. An unattributed bill cannot be reduced deliberately.
   - **Done when:** most of the spend is attributed to a named owner.

2. Delete what is not used.
   - Unattached volumes, old snapshots, idle load balancers, unused addresses, forgotten environments. This is the largest and easiest win in most accounts and requires no architectural change.
   - **Done when:** every unattached resource is deleted or justified.

3. Right-size from measurement.
   - Instances provisioned for a peak that never came. Look at actual utilisation over weeks and resize. Under 20% sustained is over-provisioned.
   - **Done when:** every instance's size is justified by observed utilisation.

4. Match the storage class to the access pattern.
   - Data read once a year should not sit in the hot tier. Lifecycle rules move it automatically, and this is often a large saving on old logs and backups.
   - **Done when:** every bucket has a lifecycle policy.

5. Look hard at data transfer.
   - Cross-zone and cross-region traffic is billed and frequently accidental — a service talking to a database in another zone, or a chatty pattern that should be batched. This line is often larger than compute and almost never examined.
   - **Done when:** transfer charges are attributed to specific flows.

6. Commit only to a proven baseline.
   - Reserved capacity or savings plans for load you are certain persists. Committing to a spike locks in the wrong number for a year.
   - **Done when:** commitments cover only the measured steady-state.

7. Alert on the anomaly, not the total.
   - A budget alert at month end is too late. Alert on a daily rate change.
   - **Done when:** a sudden daily increase raises an alert within a day.

## Verification

- Spend is attributed by owner.
- Before and after monthly figures are reported.
- Anomaly alerting is in place.
