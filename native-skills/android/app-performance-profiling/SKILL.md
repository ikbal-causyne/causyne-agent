---
name: app-performance-profiling
description: Diagnose slowness, jank, or battery drain in an Android app. Use when scrolling stutters, when startup is slow, or when users report heat or battery use.
---

# Android Performance Profiling

## Measure on the device that hurts

A flagship hides everything. Profile on a mid-tier or low-tier device, on a release build with minification on. A debug build's numbers are not related to what users experience.

## Workflow

1. Name the symptom as a metric.
   - Startup time, frame duration, memory ceiling, or wakeup count. "Feels slow" cannot be verified as fixed.
   - **Done when:** there is a number and a baseline measurement.

2. For jank, find the long frames.
   - The system tracing tool shows what ran during a dropped frame. The usual causes: work on the main thread, an unbounded layout pass, a bitmap decoded during scroll, or an over-broad recomposition.
   - **Done when:** the dropped frames have a named cause in the trace.

3. For startup, separate the phases.
   - Process creation, application initialisation, first activity, first frame. Library initialisers running eagerly at startup are the most common cause; move them behind lazy initialisation.
   - **Done when:** each phase has a duration and the largest is identified.

4. Add a baseline profile.
   - It ships ahead-of-time compilation hints for the startup and scroll paths, typically a double-digit percentage improvement for a small amount of work.
   - **Done when:** a baseline profile is generated from a realistic journey and included in the release.

5. For memory, look at retention, not allocation.
   - The heap dump shows what is held and by what. Bitmaps and cached lists dominate. Allocation churn matters less than a growing retained set.
   - **Done when:** the retained heap returns to baseline after navigating away.

6. For battery, count wakeups and network calls.
   - Every wakeup costs a radio transition. Batch network work and use scheduling constraints rather than timers.
   - **Done when:** wakeups during idle are near zero.

## Verification

- The chosen metric has improved against the recorded baseline, with both numbers stated.
- Measurement was done on a release build on a mid-tier device.
- Frame duration stays under the budget through the affected interaction.
