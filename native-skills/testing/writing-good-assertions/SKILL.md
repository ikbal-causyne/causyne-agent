---
name: writing-good-assertions
description: Write or improve test assertions. Use when a failure message does not say what broke, when tests assert on implementation details, or when a test passes with any input.
---

# Writing Good Assertions

## What a failing test owes you

The failure message alone should tell you what broke and why, without opening the test. `expected true to be false` fails that; it costs a debugging session to learn what the test was even checking.

## Workflow

1. Assert on the outcome, not on the steps.
   - Assert what the function returned and what changed in the world. Asserting that an internal helper was called with particular arguments tests the implementation, and breaks on every refactor while catching no bugs.
   - **Done when:** no assertion mentions a private function or an internal call count.

2. Compare whole values, not field by field.
   - One deep equality on the expected object gives a diff. Ten separate field assertions stop at the first and hide the rest.
   - **Done when:** structured results are asserted as a whole.

3. Make the test name the specification.
   - `rejects a token that expired one second ago`, not `test auth 3`. The name plus the failure should be enough to act on.
   - **Done when:** every test name is a sentence about behaviour.

4. Assert the negative space too.
   - What must NOT happen: no email sent, no second write, nothing logged at error level, no other field changed. Most regressions are unintended extra effects, and only a negative assertion catches them.
   - **Done when:** effect-producing code has at least one assertion about what did not happen.

5. Prove the test can fail.
   - Break the implementation deliberately and confirm the test goes red. A test that passes against broken code is worse than no test, because it is believed.
   - **Done when:** each new test has been seen to fail for the right reason.

6. Avoid conditionals in tests.
   - An `if` in a test means it asserts different things in different runs, and it can silently assert nothing. Split it into separate tests or parametrise it.
   - **Done when:** no test branches on runtime values.

## Verification

- Every new test has been observed failing against a deliberate break.
- No assertion references a private implementation detail.
- Failure output identifies the problem without opening the test file.
