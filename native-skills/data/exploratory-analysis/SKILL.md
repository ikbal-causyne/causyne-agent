---
name: exploratory-analysis
description: Analyse an unfamiliar dataset. Use when receiving new data, before modelling, or when a metric looks wrong.
---

# Exploratory Data Analysis

## The order

Understand the data before asking it questions. An analysis built on a misunderstood column produces a confident wrong answer, and nothing downstream will catch it.

## Workflow

1. Establish the shape and provenance.
   - Row count, column count, types, and where the data came from — including what was filtered before you received it. Data that arrives pre-filtered has a selection bias you must know about.
   - **Done when:** you can state what one row represents, precisely.

2. Profile every column.
   - Missing rate, cardinality, range, and the most frequent values. For dates, the minimum and maximum — future dates and epoch-zero dates are both common and both indicate a bug upstream.
   - **Done when:** every column has been profiled and anomalies are noted.

3. Ask what the missing values mean.
   - Missing at random is very different from missing because the field only applies to some rows, and different again from missing because a system failed for a period. The three demand different handling and only investigation distinguishes them.
   - **Done when:** each column with missing values has a stated explanation.

4. Check the identifiers.
   - Are the keys unique? Do foreign keys resolve? Duplicate rows from a bad join are the most common silent corruption in an analysis, and they inflate every aggregate.
   - **Done when:** key uniqueness and referential integrity have been verified.

5. Plot the distributions before summarising them.
   - A mean describes a unimodal distribution. On a bimodal or heavy-tailed one it describes nothing real. Look at the shape first.
   - **Done when:** every variable you will summarise has been plotted.

6. Look for the seams.
   - A step change in a time series usually means an instrumentation change, not a real change in the world. Check deploy dates before writing a conclusion.
   - **Done when:** discontinuities have been explained or flagged.

## Verification

- The meaning of one row is stated.
- Every column is profiled and every anomaly explained or flagged.
- Key uniqueness is verified.
- Conclusions name their caveats.
