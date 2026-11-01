---
name: android-profiler
description: Profile Android application CPU, memory allocations, thread contention, and memory leaks. Use when an app experiences frame drops, jank, high memory footprint, or slow startup.
---

# Android Application Profiling and Performance

Profile Android CPU cycles, memory allocations, garbage collection pauses, and frame rendering bottlenecks using Android profiling tools.

## Workflow

1. Configure profiling instrumentation and build variants.
   - Build a debuggable or profileable release APK using `android:profileable` in `AndroidManifest.xml` so production-representative optimizations remain active.
   - Run `./gradlew assembleDebug` or `./gradlew assembleRelease`.
   - **Done when:** the target APK is packaged with profileable or debuggable flags enabled.

2. Record CPU traces and detect UI thread stalls.
   - Trace method execution and thread contention using `adb shell am profile start --sampling <interval> <package> /data/local/tmp/cpu.trace`.
   - Perform the target user interactions, then stop profiling with `adb shell am profile stop <package>`.
   - Pull the trace file with `adb pull /data/local/tmp/cpu.trace` and inspect with Perfetto or Android Profiler.
   - **Done when:** CPU call trees identify methods spending excessive time on the main UI thread.

3. Inspect memory heaps and diagnose object leaks.
   - Trigger garbage collection and dump heap with `adb shell am dumpheap <package> /data/local/tmp/heap.hprof`.
   - Pull and convert the heap dump: `hprof-conv /data/local/tmp/heap.hprof heap_converted.hprof`.
   - Analyze retained size and identify destroyed Activities or Composables retained by static references, singletons, or uncancelled Coroutines.
   - **Done when:** leaking instances and their strong reference paths to GC roots are identified.

4. Measure frame rendering latency and jank statistics.
   - Run `adb shell dumpsys gfxinfo <package> framestats` to capture frame render times.
   - Check the 90th and 99th percentile frame times; ensure frames complete within 16.6ms (60 FPS) or 8.3ms (120 FPS).
   - **Done when:** `gfxinfo` confirms 0% janky frames during smooth scrolling interactions.

## Verification

- CPU profiling trace identifies hotspots and verifies offloading to background threads.
- Heap dump analysis confirms no retained Activity or ViewModel leaks after configuration change.
- `dumpsys gfxinfo` reports frame render times within target refresh rate budgets.
