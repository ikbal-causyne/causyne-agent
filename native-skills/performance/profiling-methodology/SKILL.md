---
name: profiling-methodology
description: Investigate a performance problem. Use whenever something is slow, before optimising anything, and when an optimisation did not help.
---

# Profiling Methodology

## The rule that saves the most time

Measure first. Developer intuition about where time goes is wrong most of the time, and an optimisation applied to the wrong place costs the effort plus the added complexity plus the bug it introduces, for no gain.

## Workflow

1. State the goal as a number.
   - "p95 under 200ms", not "faster". Without a target there is no way to know when to stop, and optimisation has no natural end.
   - **Done when:** the target and the current value are both written down.

2. Measure the right layer.
   - A slow page can be the network, the server, the database, or the client. Establish which before profiling inside one of them. The waterfall or a distributed trace answers this in a minute.
   - **Done when:** the dominant layer is identified.

3. Profile under realistic conditions.
   - Production-scale data, realistic concurrency, a release build, and a representative device or instance. A profile on ten rows on a workstation finds nothing that matters.
   - **Done when:** the profile was taken under conditions resembling production.

4. Read the profile for self time and for the call tree.
   - Self time finds a slow function. The tree finds a fast function called a million times, which is the more common and more valuable finding.
   - **Done when:** you can name the specific call path consuming the time.

5. Change one thing and re-measure.
   - Several changes at once make attribution impossible, and one of them may have made things worse.
   - **Done when:** each change has a before and after number.

6. Stop at the target.
   - Beyond it, further optimisation buys complexity nobody asked for.
   - **Done when:** the target is met and the work has stopped.

## The usual suspects, in order

Repeated work in a loop, an N+1 query, a missing index, unnecessary serialisation, a synchronous call in an async path, and an unbounded collection.

## Verification

- Before and after numbers are reported for the stated metric.
- The measurement conditions are described.
- The change is attributable to one modification.
