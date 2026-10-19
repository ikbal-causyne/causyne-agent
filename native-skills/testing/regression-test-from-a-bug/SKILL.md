---
name: regression-test-from-a-bug
description: Fix a reported bug. Use whenever a defect is being fixed, before writing the fix itself.
---

# Regression Test from a Bug

## The order

Test first, then fix. A test written after the fix passes immediately, and you never learn whether it would have caught the bug. This is the single highest-value testing discipline and the most commonly skipped.

## Workflow

1. Reproduce it before you understand it.
   - Get the exact inputs, state and steps. A bug you cannot reproduce cannot be verified as fixed, and "I could not reproduce it" is not a resolution.
   - **Done when:** you can trigger the bug on demand.

2. Write a failing test at the lowest level that captures it.
   - Reduce the reproduction to the smallest unit that still fails. A bug reproduced through the whole UI is usually a unit-level bug once narrowed.
   - **Done when:** the test fails, and it fails with the same symptom the user reported.

3. Understand the cause before changing anything.
   - The first plausible explanation is often wrong. Confirm it by predicting a second observable consequence and checking for it.
   - **Done when:** you can explain why the code produced this exact wrong result.

4. Fix the cause, not the symptom.
   - A null check that suppresses a crash leaves the wrong value flowing through the system. Ask where the null came from.
   - **Done when:** the fix addresses where the wrong value originated.

5. Look for siblings.
   - The same mistake is usually made in more than one place. Search for the pattern before closing.
   - **Done when:** the codebase has been searched for the same shape and the results addressed.

6. Confirm the test now passes and the rest still does.
   - **Done when:** the new test is green, the suite is green, and reverting the fix turns the new test red.

## Verification

- The test failed before the fix and passes after.
- Reverting the fix makes it fail again.
- A search for the same pattern elsewhere has been done and reported.
