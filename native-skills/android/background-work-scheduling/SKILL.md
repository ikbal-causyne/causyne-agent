---
name: background-work-scheduling
description: Schedule work that must survive app death on Android. Use when a task must run later, on a network connection, or periodically, and when a service or timer is being considered.
---

# Android Background Work

## Choosing the mechanism

- **Coroutine in a ViewModel** — work that only matters while the screen is open. Dies with the screen, correctly.
- **WorkManager** — deferrable work that must complete even across app death and reboot. The default for anything durable.
- **Foreground service** — user-visible, user-initiated, ongoing work: playback, navigation, an active upload. Requires a notification and a declared type.
- **Alarm manager** — exact time triggers only, such as an alarm clock. Restricted, and misused for everything else.

Almost every "run this later" is WorkManager. Background execution limits mean a plain background service will simply be killed.

## Workflow

1. State the durability requirement.
   - Must it survive the screen closing? The app being killed? A reboot? Each answer moves the choice down the list above.
   - **Done when:** the mechanism is chosen with the requirement written down.

2. Declare constraints instead of polling.
   - Network type, charging, storage, idle. The system batches constrained work across apps, which is why it costs far less battery than a timer.
   - **Done when:** the work declares every condition it needs rather than checking and rescheduling.

3. Make the worker idempotent and re-runnable.
   - It can be stopped and retried at any point. Partial progress must not corrupt state.
   - **Done when:** running the worker twice produces one effect.

4. Deduplicate with unique work.
   - Enqueue unique work with an explicit existing-work policy. Without it, a screen that enqueues on every open schedules the same job repeatedly.
   - **Done when:** repeated enqueues produce one scheduled job.

5. Return the right result.
   - Success, retry for a transient failure, failure for a permanent one. Returning failure for a network blip loses the work; returning retry for a validation error retries forever.
   - **Done when:** each failure branch returns the matching result.

6. Respect the observed limits.
   - Work is deferred, not immediate. Aggressive battery optimisation on some devices delays it further. Never promise the user a precise time.
   - **Done when:** the UI does not claim work will happen at a specific moment.

## Verification

- The work completes after force-stopping the app and rebooting.
- Enqueuing repeatedly results in one job.
- Battery historian or the WorkManager inspector shows no unexpected wakeups.
