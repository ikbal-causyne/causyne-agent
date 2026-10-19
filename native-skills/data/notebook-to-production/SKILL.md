---
name: notebook-to-production
description: Turn analysis code into something that runs reliably. Use when a notebook needs to become a scheduled job, or when analysis results cannot be reproduced.
---

# Notebook to Production

## What breaks in the move

Hidden state. A notebook's output depends on which cells were run and in what order, and that order is not recorded. Code that works in a notebook frequently does not work when run top to bottom — which is what any scheduler will do.

## Workflow

1. Prove it runs top to bottom first.
   - Restart the kernel and run all. If it fails, the notebook depended on state that no longer exists, and the analysis result is not reproducible either.
   - **Done when:** a fresh kernel produces the same result end to end.

2. Extract logic into functions in a module.
   - The notebook becomes a thin caller. Functions can be tested, imported and reused; cells cannot.
   - **Done when:** the notebook contains calls and plots, not logic.

3. Replace every hardcoded path and credential.
   - Paths, dates and credentials become parameters or configuration. A hardcoded date silently produces stale results forever.
   - **Done when:** nothing environment-specific is embedded in the code.

4. Pin the environment.
   - A lock file. Analysis results depend on library versions, and a silent upgrade changes numbers without changing code.
   - **Done when:** a fresh environment built from the lock file reproduces the result.

5. Add validation and make failure loud.
   - Assertions on row counts, ranges and key uniqueness. A scheduled job that fails silently produces wrong numbers that people act on.
   - **Done when:** a bad input fails the run visibly.

6. Test the extracted functions.
   - Start with the transformations that carry business logic. These are where a wrong result is both most likely and most costly.
   - **Done when:** the core transformations have tests with known inputs and outputs.

## Verification

- A fresh environment reproduces the result exactly.
- The module runs from a scheduler with no notebook.
- Corrupt input fails loudly.
- The core transformations have tests.
