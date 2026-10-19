---
name: metric-definition
description: Define a business or product metric. Use when two teams report different numbers for the same thing, or before building a dashboard.
---

# Metric Definition

## Why the same metric gives two answers

Because it was never defined. "Active users" has a dozen reasonable readings, and every team picks one implicitly. The disagreement is discovered in a meeting, months later, after decisions have been made on both numbers.

## Workflow

1. Write the definition in a sentence a non-engineer can check.
   - Include the population, the event, the window, and the exclusions. "Users who performed at least one search in the trailing 28 days, excluding internal accounts and bots, counted by account not by device."
   - **Done when:** two people can independently implement it and agree.

2. Decide the time semantics explicitly.
   - Which timezone, event time or ingestion time, and how late-arriving data is handled. These three choices change the number and are almost never written down.
   - **Done when:** all three are stated.

3. Name the exclusions.
   - Internal users, test accounts, bots, refunded orders, deleted records. Each one is a decision, and a metric that excludes nothing is usually wrong.
   - **Done when:** every exclusion is listed with a reason.

4. Define it once, in one place.
   - A semantic layer or a shared model that every dashboard queries. The same metric computed in three dashboards will give three answers within a quarter.
   - **Done when:** every consumer reads the same definition.

5. State the expected range and alert outside it.
   - A metric with no expected range cannot be sanity-checked. If it doubles overnight, is that success or an instrumentation bug? Usually the latter.
   - **Done when:** an expected band exists and a breach raises a question.

6. Version the definition.
   - When it changes, the historical series changes. Record when and why, and never silently restate history.
   - **Done when:** definition changes are dated and visible on the chart.

## Verification

- Two independent implementations produce the same number.
- The definition names population, event, window, timezone, and exclusions.
- Every dashboard reads one definition.
