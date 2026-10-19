---
name: core-web-vitals
description: Improve page load or interaction performance on the web. Use when a page feels slow, when Lighthouse scores are low, or before shipping a public-facing page.
---

# Core Web Vitals

## The three metrics, and what actually moves them

- **LCP** (largest contentful paint) — how long until the main thing appears. Dominated by server response time and by whether the hero image or font is discoverable early.
- **INP** (interaction to next paint) — how long the page takes to respond to input. Dominated by long tasks on the main thread.
- **CLS** (cumulative layout shift) — how much things move. Dominated by images and ads without reserved space, and by fonts swapping.

## Workflow

1. Measure before changing anything.
   - Lab first (Lighthouse, DevTools performance panel), then field data if available. Lab numbers on a fast laptop are optimistic; throttle to a mid-tier device.
   - **Done when:** you have a baseline number for each of the three metrics.

2. Fix LCP at the source.
   - Identify the LCP element in DevTools. It is almost always an image or a heading blocked by a font.
   - Preload it, set `fetchpriority="high"`, serve modern formats, and size it correctly. Never lazy-load the LCP image — that is the single most common self-inflicted LCP regression.
   - **Done when:** the LCP element starts loading in the first network round trip.

3. Fix CLS by reserving space.
   - Every image and video gets explicit `width` and `height` (or `aspect-ratio`). Every font uses `font-display: optional` or `swap` with a metric-matched fallback.
   - **Done when:** CLS is under 0.1 and the page does not visibly jump on reload.

4. Fix INP by breaking up long tasks.
   - Find tasks over 50ms in the performance panel. Split them, defer them, or move them off the main thread.
   - Ship less JavaScript: code-split by route, drop polyfills for browsers you do not support, and audit the bundle for a single dependency dominating it.
   - **Done when:** no task on the interaction path exceeds 50ms.

5. Re-measure.
   - **Done when:** each metric has improved against the recorded baseline, with the numbers stated.

## Verification

- Lighthouse on a throttled mid-tier profile shows LCP under 2.5s, INP under 200ms, CLS under 0.1.
- The before and after numbers are reported side by side.
