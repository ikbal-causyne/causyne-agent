---
name: data-processing-pipelines
description: Process files or datasets in Python. Use when a script loads an entire file into memory, when processing is slow, or when a pipeline fails partway through with no recovery.
---

# Data Processing Pipelines

## The two failures

Loading everything into memory, and having no way to resume. Both are invisible on the sample file and fatal on the real one.

## Workflow

1. Stream rather than load.
   - Iterate the file; do not read it whole. `csv.reader` over a file object, `json` lines one per line, `pandas.read_csv(chunksize=...)`, or Polars in lazy mode.
   - **Done when:** peak memory is roughly constant regardless of input size.

2. Make the pipeline a chain of generators.
   - Each stage takes an iterable and yields an iterable. Nothing materialises a list. This composes, stays constant-memory, and is testable stage by stage.
   - **Done when:** no stage builds a list of the whole dataset.

3. Validate at the boundary and quarantine the failures.
   - Bad rows are normal in real data. Validate on entry, write rejects to a separate file with the reason, and continue. A pipeline that stops on row 400,000 wastes the previous 399,999.
   - **Done when:** a deliberately malformed row lands in the reject file and processing continues.

4. Make the whole thing resumable and idempotent.
   - Checkpoint progress, and key output by a stable identifier so re-running overwrites rather than duplicates. Write to a temporary path and rename on completion so a partial file is never mistaken for a finished one.
   - **Done when:** interrupting mid-run and restarting produces the same result as an uninterrupted run.

5. Parallelise only after measuring.
   - Find out whether the bottleneck is I/O or CPU. Threads help I/O; processes help CPU; neither helps if the bottleneck is a single slow query upstream.
   - **Done when:** the bottleneck is named and the chosen mechanism matches it.

## Verification

- Peak memory stays flat as input size grows tenfold.
- A malformed row is quarantined, not fatal.
- Killing the process mid-run and restarting yields the same output.
