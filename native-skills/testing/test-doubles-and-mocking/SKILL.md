---
name: test-doubles-and-mocking
description: Use mocks, stubs, or fakes in tests. Use when a test needs an external dependency, when mocks make tests brittle, or when a suite mocks its own internals.
---

# Test Doubles

## The kinds, and when each is right

- **Stub** — returns canned answers. For queries: "this returns three users."
- **Fake** — a working lightweight implementation. An in-memory repository. Usually the best of the four.
- **Mock** — asserts it was called in a particular way. For commands with no observable result: "an email was sent."
- **Spy** — records calls for later inspection.

Prefer a fake. It exercises real behaviour and does not encode the caller's implementation into the test.

## Workflow

1. Mock only at real boundaries.
   - Network, filesystem, clock, randomness, and third-party services. Mocking your own modules couples the test to the current internal structure — the thing you most want to be free to change.
   - **Done when:** every double replaces something outside the unit under test.

2. Never mock what you can control cheaply.
   - A containerised database is faster to set up and catches far more than a mocked repository. Same for a local HTTP server versus a mocked client.
   - **Done when:** slow-and-external is the only justification for each double.

3. Make time and randomness injectable.
   - Pass a clock and a source of randomness rather than calling the global. This removes the need to mock a global, which is the most fragile kind of double.
   - **Done when:** no test needs to patch a global time or random function.

4. Keep the double honest.
   - A stub returning a shape the real dependency never returns produces a green test and a broken system. Where the language allows, type the double against the real interface, and add one contract test against the real dependency.
   - **Done when:** at least one test exercises the real dependency for each mocked boundary.

5. Assert interactions sparingly.
   - Verify a call only when the call IS the outcome. Verifying every internal call turns the test into a transcript of the implementation.
   - **Done when:** interaction assertions exist only for side effects with no observable result.

## Verification

- Each double replaces a genuine external boundary.
- A contract test covers each mocked dependency against the real thing.
- Refactoring internals does not require changing doubles.
