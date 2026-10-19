---
name: ssr-hydration-correctness
description: Debug or prevent a server-rendering hydration mismatch. Use when the console warns about hydration, when content flashes and changes on load, or when a component behaves differently on first render.
---

# SSR Hydration Correctness

## What a mismatch means

The server produced one tree and the client produced a different one from the same props. The framework has to discard its work and re-render, which costs the performance the server render was supposed to buy — and in the worst case leaves the DOM and the component state disagreeing.

## The four causes, in order of frequency

1. **Non-deterministic values.** `Date.now()`, `Math.random()`, `crypto.randomUUID()` produce different output on each side.
2. **Browser-only APIs read during render.** `window`, `document`, `localStorage`, `matchMedia`. These are undefined on the server, so the branch differs.
3. **Locale or timezone formatting.** The server formats in UTC and the client in the user's zone.
4. **Invalid HTML nesting.** A `<div>` inside a `<p>`, or a `<td>` outside a row. The browser repairs the DOM, so the client tree no longer matches what was sent.

## Workflow

1. Read the mismatch message for the specific element.
   - Modern frameworks name the node and show both trees. That usually identifies the cause outright.
   - **Done when:** you can point at the exact element and value that differ.

2. Move non-deterministic work out of render.
   - Compute it on the server and pass it as a prop, or compute it in an effect after mount and accept one frame of the fallback.
   - **Done when:** render is a pure function of props on both sides.

3. Gate browser-only reads behind mount.
   - Read the value in an effect and store it in state, rather than reading it during render. The first render then matches the server by construction.
   - **Done when:** no browser global is read during render.

4. Fix formatting by fixing the inputs.
   - Send an ISO timestamp and an explicit timezone; format identically on both sides. Do not paper over it with a suppression attribute — that hides the mismatch without removing it.
   - **Done when:** the same input formats to the same string on both sides.

5. Validate the HTML.
   - Run the server output through a validator. Nesting errors produce mismatches that look inexplicable at the component level.
   - **Done when:** the server HTML validates.

## Verification

- No hydration warning in the console on any route.
- No visible flash of changed content on load.
- Disabling JavaScript still shows correct server-rendered content.
