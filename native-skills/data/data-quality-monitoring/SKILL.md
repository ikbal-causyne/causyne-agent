---
name: data-quality-monitoring
description: Detect data problems before people act on them. Use when bad data has reached a dashboard, or when setting up a new data source.
---

# Data Quality Monitoring

## The failure that costs most

Not the pipeline that breaks — that gets noticed. The pipeline that keeps running while the data quietly goes wrong. Those are discovered weeks later, after decisions have been made on the numbers.

## The dimensions worth monitoring

- **Freshness** — is the newest record as recent as it should be.
- **Volume** — is the row count within its normal band.
- **Schema** — have columns or types changed upstream.
- **Distribution** — has a column's shape shifted beyond its normal variation.
- **Uniqueness and referential integrity** — are keys still unique, do references still resolve.

## Workflow

1. Baseline before alerting.
   - Measure normal for a few weeks. Alerting on a guessed threshold produces noise, and a noisy alert is an ignored alert.
   - **Done when:** each check has a threshold derived from observed variation.

2. Check freshness first.
   - It catches the most failures for the least effort. A stale partition means the pipeline is broken regardless of what else passes.
   - **Done when:** every dataset has a maximum-age alert.

3. Detect schema change at ingestion.
   - An upstream column rename or type change is silent and corrupting. Compare the incoming schema to the expected one and fail on an unexpected difference.
   - **Done when:** a schema change stops the pipeline rather than propagating.

4. Monitor distributions on the columns that matter.
   - Null rate, distinct count, and the quantiles of numeric columns. A null rate moving from 1% to 40% is a broken upstream field, and no error will be raised.
   - **Done when:** key columns have distribution checks with bands.

5. Route alerts to an owner.
   - Every dataset has a name attached. An alert to a shared channel with no owner is an alert nobody acts on.
   - **Done when:** each dataset's alerts have a named owner.

6. Surface the check results next to the data.
   - A dashboard reading a dataset that failed its checks should say so. Otherwise the consumer cannot know.
   - **Done when:** consumers can see the freshness and check status of what they are reading.

## Verification

- A deliberately stale partition raises an alert.
- An upstream column rename stops the pipeline.
- A spike in the null rate is detected.
- Every alert has an owner.
