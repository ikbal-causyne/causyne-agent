---
name: anr-audit-and-fix
description: Investigate and resolve Android Application Not Responding (ANR) freezes. Use when an app triggers an ANR dialog, blocks the main UI thread, or deadlocks on background operations.
---

# Android ANR Audit and Remediation

Diagnose, reproduce, and resolve Application Not Responding (ANR) occurrences caused by main thread contention, long-running disk/network I/O, lock deadlocks, or slow BroadcastReceivers.

## Workflow

1. Extract and inspect ANR trace dumps.
   - Run `adb bugreport bugreport.zip` or pull `/data/anr/traces.txt` using:
     `adb shell "cat /data/anr/anr_* 2>/dev/null || cat /data/anr/traces.txt 2>/dev/null" > /tmp/anr_trace.txt`.
   - Locate the `"main"` thread section in the dump and inspect its state (`SUSPENDED`, `BLOCKED`, `MONITOR`, or `TIMED_WAIT`).
   - Identify the stack trace at the exact moment of the ANR trigger.
   - **Done when:** the blocking call or synchronized lock in the main thread stack trace is identified.

2. Audit main-thread disk, database, and network operations.
   - Configure `StrictMode` in debug builds:
     `StrictMode.setThreadPolicy(StrictMode.ThreadPolicy.Builder().detectDiskReads().detectDiskWrites().detectNetwork().penaltyLog().build())`.
   - Wrap Room database transactions, Datastore accesses, and JSON serialization calls with `withContext(Dispatchers.IO)`.
   - **Done when:** all blocking file, network, and database operations run on background dispatcher threads.

3. Resolve synchronization deadlocks and contention.
   - Replace blocking `runBlocking { ... }` calls on the main thread with proper Coroutine lifecycle scopes (`viewModelScope.launch` or `lifecycleScope.launch`).
   - Prevent worker threads holding locks required by the main UI thread during state updates.
   - **Done when:** `runBlocking` is eliminated from UI components and mutex locks are released promptly.

4. Enforce BroadcastReceiver time budgets.
   - Limit `onReceive()` execution to under 5 seconds by delegating heavy tasks to Android Jetpack `WorkManager`.
   - Use `goAsync()` if asynchronous handling is strictly required within the receiver lifecycle.
   - **Done when:** `onReceive()` returns immediately after scheduling background work.

## Verification

- ANR traces in `/data/anr/` show zero recent occurrences for the application package.
- `StrictMode` logs in `adb logcat` verify zero main-thread disk or network violations.
- UI remains responsive and fluid during intensive data synchronization operations.
