---
name: test-strategy-and-pyramid
description: Decide what to test and at what level. Use when a suite is slow and flaky, when coverage is high but bugs still ship, or when starting testing on an untested codebase.
---

# Test Strategy

## The proportions

Many fast unit tests, fewer integration tests, very few end-to-end tests. Inverting this gives a suite that is slow, flaky, and gives its feedback long after the mistake was made. But note the real goal: CONFIDENCE per second of runtime. A pure unit suite that mocks every boundary can pass while the system is entirely broken.

## Workflow

1. Test behaviour at the boundary the user cares about.
   - For a library, that is its public API. For a service, its HTTP surface. For a UI, what a user can see and do. Testing internals locks the implementation and makes refactoring a test rewrite.
   - **Done when:** the tests still pass after an internal refactor.

2. Put each test at the lowest level that gives real confidence.
   - Pure logic: unit. A query, a serialiser, an auth check: integration against a real dependency. A critical user journey: end-to-end, and only a handful of them.
   - **Done when:** every test's level is justified by what it would catch.

3. Use real dependencies where they are cheap.
   - A containerised database in an integration test catches what a mocked repository never will — wrong SQL, a missing index, a constraint violation. Mock only what is slow, external, or non-deterministic.
   - **Done when:** database and serialisation code is tested against the real thing.

4. Treat coverage as a diagnostic, not a target.
   - Coverage finds untested code. It cannot tell whether the tests assert anything meaningful. A coverage target produces tests written to satisfy the target.
   - **Done when:** coverage is reported and used to find gaps, not enforced as a gate on its own.

5. Delete flaky tests or fix them the same day.
   - A tolerated flaky test teaches the team to re-run rather than to read. That habit is what lets a real failure ship.
   - **Done when:** the suite has no known intermittent failures.

## Verification

- The unit suite runs in seconds.
- The full suite runs in minutes.
- Ten consecutive runs give identical results.
- An internal refactor requires no test changes.
