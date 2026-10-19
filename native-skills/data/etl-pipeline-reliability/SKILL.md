---
name: etl-pipeline-reliability
description: Build or fix a data pipeline. Use when a scheduled job fails silently, when a rerun duplicates data, or when downstream numbers are wrong.
---

# ETL Pipeline Reliability

## The two properties

Idempotence and observability. A pipeline that cannot be safely re-run cannot be fixed after a failure, and one that fails silently produces wrong numbers that people act on for weeks.

## Workflow

1. Make every run idempotent.
   - Re-running for the same period must produce the same result, not double it. Partition the output by period and replace the partition wholesale, rather than appending.
   - **Done when:** running the same period twice yields identical output.

2. Partition by logical time, not by run time.
   - A job for yesterday should produce yesterday's partition whenever it runs. Keying on the run time makes a backfill impossible and a late run wrong.
   - **Done when:** the output partition is determined by the data's period.

3. Validate at every boundary.
   - Row counts within an expected range, no unexpected nulls in required columns, keys unique, and totals reconciling with the source. Fail the run rather than writing bad data — downstream consumers cannot tell the difference.
   - **Done when:** each stage has assertions that stop the pipeline on violation.

4. Quarantine bad records, do not drop them.
   - Write rejects with the reason to a separate location. Silently dropping rows makes numbers wrong with no trace.
   - **Done when:** every rejected record is retrievable with its reason.

5. Alert on staleness and on volume, not only on errors.
   - The dangerous failure is the job that succeeds while producing nothing, or a tenth of the usual rows. Alert if the newest partition is older than expected, or the volume moves outside its band.
   - **Done when:** an empty successful run raises an alert.

6. Make backfill a normal operation.
   - Parameterise the period and support running a range. A pipeline that cannot backfill cannot recover from an outage.
   - **Done when:** a range backfill runs with one command and produces correct partitions.

## Verification

- Re-running a period produces identical output.
- A deliberately corrupted input fails the run rather than writing.
- An empty run triggers an alert.
- A backfill over a week produces correct partitions.
