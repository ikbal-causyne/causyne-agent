---
name: compose-state-and-recomposition
description: Write or fix Jetpack Compose UI. Use when a screen stutters, when state resets on rotation, or when a composable recomposes more than expected.
---

# Compose State and Recomposition

## The model

A composable is a function of state. When state changes, Compose re-runs the functions that READ it. Performance problems are almost always the wrong scope reading the state, and correctness problems are almost always state stored in the wrong place.

## Workflow

1. Hoist state to the lowest common owner.
   - A composable that owns state cannot be reused or previewed with different values. Take state as a parameter and emit events upward.
   - **Done when:** every reusable composable is stateless and driven by parameters.

2. Survive configuration change and process death.
   - `remember` survives recomposition only. `rememberSaveable` survives configuration change. A ViewModel with a saved-state handle survives process death.
   - Choose by what the user would be upset to lose.
   - **Done when:** rotating and restoring from background both preserve what the user expects.

3. Read state as late as possible.
   - Reading a frequently changing value at the top of a screen recomposes the whole screen. Pass a lambda that reads it, and read inside the small composable that displays it — or use the graphics-layer overload for scroll-driven values so it never recomposes at all.
   - **Done when:** a high-frequency value recomposes only the element that displays it.

4. Give list items stable keys.
   - `items(list, key = { it.id })`. Without keys, inserting at the front recomposes every item and loses their internal state.
   - **Done when:** inserting at the head of a list does not disturb the rest.

5. Keep side effects in effect handlers.
   - A composable body may run many times, in any order, and be abandoned. Anything with a side effect belongs in `LaunchedEffect`, `DisposableEffect`, or `SideEffect`, keyed correctly.
   - **Done when:** no network call, no logging and no mutation happens in a composable body.

6. Watch out for unstable parameters.
   - A parameter Compose cannot prove stable forces recomposition every time. Prefer immutable types and persistent collections; mark types stable only when the guarantee is real.
   - **Done when:** the compiler's stability report shows the hot composables as skippable.

## Verification

- Layout inspector recomposition counts stay flat during interaction that should not change a given element.
- Rotation preserves state.
- Scrolling a long list stays smooth on a mid-tier device.
