---
name: iam-least-privilege
description: Configure cloud permissions or service accounts. Use when creating a role, when a policy grants broad access, or during a security review.
---

# IAM Least Privilege

## The default failure

A wildcard policy attached because something did not work and the error message did not say which permission was missing. It works, so it stays, and it is a full compromise waiting for one leaked credential.

## Workflow

1. Give every workload its own identity.
   - Shared credentials make it impossible to tell what did something, and impossible to revoke one consumer without breaking the others.
   - **Done when:** each workload has a distinct identity.

2. Start from deny and add what fails.
   - Run with no permissions, read the access-denied errors, and grant exactly those. This is slower than starting broad and narrowing, and it is the only approach that actually converges.
   - **Done when:** the policy contains only permissions the workload demonstrably needs.

3. Scope to resources, not just to actions.
   - Read on one bucket, not read on all buckets. Most policies get the action right and leave the resource as a wildcard, which is most of the exposure.
   - **Done when:** no resource field is a bare wildcard.

4. Use short-lived credentials.
   - Workload identity federation or the platform's instance identity. A long-lived key in an environment variable is a key in every backup, log and image.
   - **Done when:** no static long-lived credential exists for any workload.

5. Add conditions where they cost nothing.
   - Source address range, requiring encryption in transit, or requiring multi-factor for sensitive actions. Each closes an avenue at no operational cost.
   - **Done when:** high-value permissions carry a condition.

6. Review with the analyser and remove unused grants.
   - Cloud providers report permissions granted but never used. That report is the shortest path to a smaller blast radius.
   - **Done when:** permissions unused for a stated period are removed.

## Verification

- No policy contains a wildcard action on a wildcard resource.
- Each workload has its own identity with its own policy.
- No long-lived static credential exists.
- The access analyser reports no unused permission older than the review period.
