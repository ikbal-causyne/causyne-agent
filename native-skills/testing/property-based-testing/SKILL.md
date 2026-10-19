---
name: property-based-testing
description: Test a function with many valid inputs. Use when example tests keep missing edge cases, when testing a parser, serialiser, or algorithm, or when input space is large.
---

# Property-Based Testing

## The shift

Instead of "for this input, expect this output", state a property that must hold for EVERY input, and let the framework generate hundreds of them — including the pathological ones nobody thinks to write: empty, one element, duplicates, maximum integers, unusual Unicode.

## The properties worth reaching for

- **Round trip** — `decode(encode(x)) == x`. The single most valuable property, and it applies to every serialiser, parser and codec.
- **Invariant** — sorting preserves length and multiset; a transfer preserves the total balance.
- **Idempotence** — `f(f(x)) == f(x)`. Normalisers, formatters, deduplicators.
- **Oracle** — the fast implementation agrees with the obviously correct slow one.
- **Commutativity or ordering** — order of independent operations does not change the result.

## Workflow

1. Pick the property before the generator.
   - Write the invariant as a sentence first. A generator without a property is just random input.
   - **Done when:** the property is stated in one sentence.

2. Generate the real input domain.
   - Constrain the generator to what the function actually accepts, but no further. Over-constraining hides the bugs; the framework's default string generator producing surrogate pairs and combining characters is a feature, not a nuisance.
   - **Done when:** the generator covers the documented domain and nothing outside it.

3. Use the shrunk counterexample.
   - On failure the framework reduces the input to a minimal failing case. That minimal case is usually the whole diagnosis.
   - **Done when:** the reported failure is minimal and reproducible from its seed.

4. Keep the failing case as a regression test.
   - Add the specific counterexample as an ordinary example test. Property tests are randomised; a pinned example guarantees this exact bug stays fixed.
   - **Done when:** each discovered failure has a pinned example test.

5. Combine, do not replace.
   - Properties catch classes of bugs; examples document intent and pin known cases. A suite needs both.
   - **Done when:** the module has both property and example tests.

## Verification

- Each property runs several hundred cases in CI.
- A deliberately introduced off-by-one is caught.
- Every past failure has a pinned regression test.
