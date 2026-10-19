---
name: cross-platform-tradeoffs
description: Decide between native and cross-platform, or work within Flutter or React Native. Use when choosing a mobile stack, or when a cross-platform app hits a platform limit.
---

# Cross-Platform Trade-offs

## The honest framing

Cross-platform buys shared business logic and one team. It costs latency on new platform features, a harder time with deep platform integration, and a debugging path that crosses a bridge. Neither answer is universally right; the wrong move is choosing without naming the trade.

## Workflow

1. Name the platform-specific surface first.
   - Widgets, watch apps, background processing, camera and audio pipelines, accessibility services, deep OS integration. If the product depends on several of these, the shared-code saving is smaller than it looks.
   - **Done when:** the platform-specific requirements are listed before the framework is chosen.

2. Match the choice to the team, not to the benchmark.
   - A team fluent in one ecosystem will ship better software in it than in a technically superior one they are learning. This usually dominates the technical comparison.
   - **Done when:** the decision states the team's existing skills as an input.

3. Isolate the platform boundary.
   - Whatever the choice, platform-specific code lives behind one interface. This keeps the shared code testable and keeps a future migration bounded.
   - **Done when:** platform APIs are reached through a single abstraction per capability.

4. Follow each platform's conventions in the UI.
   - Navigation patterns, back behaviour, share sheets and system fonts differ. An app that ignores this is immediately recognisable as a port, and users read that as low quality.
   - **Done when:** navigation and system interactions match each platform's convention.

5. Test on both, on real devices.
   - A simulator hides performance, permissions, and hardware differences. Cross-platform bugs concentrate exactly where the two platforms differ.
   - **Done when:** every release is exercised on a physical device of each platform.

6. Budget for the bridge.
   - Frequent crossings — per-frame updates, large payloads, high-rate sensors — are the usual performance cliff. Keep hot paths on one side.
   - **Done when:** no hot path crosses the boundary per frame.

## Verification

- The decision is written down with the platform-specific requirements that informed it.
- Platform code sits behind one abstraction per capability.
- Both platforms are tested on physical hardware.
