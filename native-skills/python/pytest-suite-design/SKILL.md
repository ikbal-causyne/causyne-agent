---
name: pytest-suite-design
description: Write or restructure Python tests. Use when tests share mutable state, when a suite is slow, or when failures are hard to read.
---

# Pytest Suite Design

## Workflow

1. Make each test independent.
   - A test that depends on another having run first will fail under `-p no:randomly`, under `-n auto`, and in any order but the current one. Shared module-level state is the usual cause.
   - **Done when:** the suite passes with tests shuffled and with parallel execution.

2. Use fixtures for setup, not for cleverness.
   - A fixture should produce one thing and clean it up with `yield`. Scope it as narrowly as correctness allows: `function` by default, wider only when construction is genuinely expensive AND the object is immutable.
   - A mutable `session`-scoped fixture is shared state with extra steps.
   - **Done when:** no fixture wider than `function` scope is mutated by a test.

3. Parametrise instead of duplicating.
   - `@pytest.mark.parametrize` turns eight near-identical tests into one with eight cases, each reported separately. Give the cases `ids` so a failure names the case rather than an index.
   - **Done when:** no two tests differ only by literal values.

4. Assert on behaviour, not implementation.
   - Assert what the function returns and what it does to the world. Asserting that a private helper was called with particular arguments locks the implementation and makes every refactor a test rewrite.
   - **Done when:** the tests still pass after an internal refactor that preserves behaviour.

5. Isolate the outside world.
   - No test touches the real network, the real clock, or a real database unless it is explicitly an integration test and marked as one. `monkeypatch`, `freezegun`, and `responses` cover most of it.
   - **Done when:** the unit suite passes with the network disabled.

6. Make failures self-explanatory.
   - One logical assertion per test, and a name that states the expected behaviour: `test_expired_token_is_rejected`, not `test_auth_2`.
   - **Done when:** a failure name alone communicates what broke.

## Verification

- `pytest -p no:randomly --randomly-seed=last` and `pytest -n auto` both pass.
- The unit suite passes with no network access.
- Every test name reads as a statement about behaviour.
