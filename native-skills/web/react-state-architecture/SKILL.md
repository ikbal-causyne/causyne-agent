---
name: react-state-architecture
description: Choose where state lives in a React application. Use when props are threaded through many layers, when a context re-renders the whole tree, or when a global store is being added.
---

# React State Architecture

## The ordering rule

State belongs at the lowest level that can own it. Every level it is lifted above that is a re-render nobody asked for. Reach for the next tier only when the current one provably fails.

1. Local `useState` — owned by one component.
2. Lifted to the nearest common parent — shared by siblings.
3. URL — anything the user should be able to link to, refresh into, or navigate back to. Filters, tabs, pagination, selected item.
4. Server cache (TanStack Query, SWR, RSC) — anything that came from the network. This is not application state; it is a cache with staleness, and treating it as state is the single most common source of duplicate fetching and stale UI.
5. Context — genuinely global and rarely changing: theme, locale, the authenticated user.
6. A store (Zustand, Redux) — high-frequency global state with complex updates. Rare.

## Workflow

1. Classify each piece of state against the tiers above.
   - The question that resolves most cases: does this come from the server? If yes, it belongs in the server cache, not in `useState` with a `useEffect`.
   - **Done when:** every piece of state is assigned to a tier with a stated reason.

2. Move URL-shaped state to the URL.
   - Search params via the router. This gets back-button and shareability for free, both of which are otherwise bugs users will report.
   - **Done when:** reloading the page restores the same view.

3. Split contexts by update frequency.
   - One context holding both the theme and a live cursor position re-renders every consumer on every mouse move. Separate them.
   - **Done when:** no context holds values with different change rates.

4. Derive instead of storing.
   - A value computable from other state must not be stored. Two sources of truth drift, and the drift is a bug class you cannot test away.
   - **Done when:** no `useEffect` exists whose only job is to sync one state value from another.

## Verification

- The React DevTools profiler shows no component re-rendering on an update it does not display.
- Reloading any view restores it exactly.
- Searching for `useEffect` finds none that only call `setState` from other state.
