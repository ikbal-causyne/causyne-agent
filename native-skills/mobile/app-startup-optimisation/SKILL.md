---
name: app-startup-optimisation
description: Reduce mobile app startup time. Use when a cold start takes more than about two seconds, when a splash screen lingers, or when the first frame is blank.
---

# App Startup Optimisation

## The three starts

Cold (no process), warm (process alive, activity recreated), hot (everything alive). Cold start is what users judge you on, and it is the only one worth optimising first.

## Workflow

1. Measure each phase separately.
   - Process creation, framework initialisation, application setup, first layout, first frame, first useful content. Optimising before you know which dominates is guessing.
   - **Done when:** every phase has a measured duration on a mid-tier device.

2. Move work out of application initialisation.
   - Analytics, crash reporting, image loaders and dependency graphs commonly initialise eagerly. Almost none of them are needed before the first frame. Defer them behind lazy initialisation or a post-first-frame hook.
   - **Done when:** application setup does only what the first screen needs.

3. Make the first screen cheap.
   - The first frame should render from cached or placeholder data, not from a network call. A skeleton that appears instantly beats correct content that appears in three seconds.
   - **Done when:** something meaningful renders before any network response.

4. Do not hide the problem behind a splash screen.
   - An artificial splash delay makes the measured start longer. Use the platform's own splash mechanism, which shows during process creation and costs nothing.
   - **Done when:** no artificial delay exists on the startup path.

5. Ship ahead-of-time compilation hints.
   - A baseline profile covering launch and the first interaction removes interpretation on the critical path.
   - **Done when:** a profile generated from a real launch journey is included in the release.

6. Audit the dependency graph.
   - Each library initialising at startup costs time. Some register a startup provider automatically — check what is actually running before your first line of code.
   - **Done when:** every automatic initialiser is either needed or disabled.

## Verification

- Cold start to first useful content is measured before and after, on a mid-tier device, on a release build.
- Nothing on the startup path performs network or disk work that the first screen does not need.
