---
name: llm-evaluation
description: Measure whether a model, prompt, or pipeline change is an improvement. Use before shipping any prompt or model change, and when quality is being debated from anecdotes.
---

# LLM Evaluation

## Why anecdotes fail here

Model output is non-deterministic and its failures are uneven. A change that fixes the three cases you tried can break twenty you did not. Without a fixed set, every prompt change is a guess and quality drifts in both directions unnoticed.

## Workflow

1. Build the set from real failures.
   - Start with cases the system got wrong in production. Fifty realistic cases beat five hundred synthetic ones. Include the ambiguous, the adversarial, and the out-of-scope.
   - **Done when:** the set contains every failure mode you have actually observed.

2. Choose the grader to match the task.
   - Exact match or a schema check for structured output — cheap and exact, use it wherever it applies.
   - A programmatic check for verifiable properties: does the code run, is the citation real, is the total correct.
   - A model grader for open-ended quality, with a rubric and a calibration set showing it agrees with human judgement.
   - Human review for the final call on anything user-facing.
   - **Done when:** every case has a grader and model graders are calibrated against human labels.

3. Fix the seed and pin the model version.
   - A provider silently updating a model version invalidates every comparison. Pin explicitly and record it with the results.
   - **Done when:** results record the exact model version and parameters.

4. Compare against a baseline, always.
   - A score means nothing alone. Run the current version and the change on the same set, and report both.
   - **Done when:** every result is a paired comparison.

5. Look at regressions, not just the average.
   - A change that lifts the mean while breaking five previously-passing cases is usually not worth shipping. Report what got worse.
   - **Done when:** the per-case diff is reviewed, not just the aggregate.

6. Run it in CI.
   - A manual evaluation is run when someone remembers. Gate on the regression count.
   - **Done when:** a prompt change with regressions fails the build.

## Verification

- The set covers every known failure mode.
- Results are paired against a baseline on a pinned model version.
- Per-case regressions are reported.
- CI runs the evaluation on prompt changes.
