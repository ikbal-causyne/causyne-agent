---
name: end-to-end-test-stability
description: Write or fix browser or device end-to-end tests. Use when tests fail intermittently, when they rely on sleeps, or when a suite is disabled because it is unreliable.
---

# End-to-End Test Stability

## Where flakiness comes from

Almost always timing: the test acts before the application is ready. Fixed sleeps do not fix this — they make it rarer and slower, which is the worst of both.

## Workflow

1. Replace every sleep with a condition.
   - Wait for the element to be visible and enabled, for the request to complete, for the loading state to disappear. Modern frameworks auto-wait on assertions; use them rather than hand-rolled polling.
   - **Done when:** the suite contains no fixed-duration sleep.

2. Select by what the user perceives.
   - Role and accessible name, then visible text, then a dedicated test identifier. Never a CSS class or an XPath through the DOM structure — those break on every styling change and test nothing meaningful.
   - **Done when:** no selector depends on styling or DOM nesting.

3. Isolate each test's data.
   - Every test creates what it needs with unique values and cleans up. Shared fixtures mean tests interfere and cannot run in parallel — and the failure appears in whichever test ran second.
   - **Done when:** the suite passes with tests run in a random order and in parallel.

4. Control the network.
   - For anything but a deliberate integration test, intercept and stub external calls. A third party's rate limit or outage should not fail your build.
   - **Done when:** the suite passes with external network access blocked.

5. Capture evidence on failure.
   - Screenshot, DOM snapshot, video, and network log. A CI failure with no artefact costs an hour of local reproduction, and some failures do not reproduce locally at all.
   - **Done when:** a failing run leaves artefacts sufficient to diagnose without re-running.

6. Keep the suite small and critical.
   - Cover the handful of journeys whose breakage would be an emergency. An end-to-end test for every form is a suite nobody waits for.
   - **Done when:** every end-to-end test covers a journey that would be an incident if broken.

## Verification

- Twenty consecutive runs pass without a retry.
- The suite passes in a random order and in parallel.
- A deliberate failure leaves a screenshot and a network log.
