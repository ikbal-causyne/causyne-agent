---
name: offline-first-sync
description: Make a mobile app work without a network connection. Use when the app shows an error offline, when data is lost on a failed request, or when local and server state diverge.
---

# Offline-First Sync

## The premise

The local store is the source of truth for the UI. The network is a background synchroniser. Every screen reads local data and renders immediately; nothing waits on a request. Getting this backwards is why most apps are unusable on a train.

## Workflow

1. Write locally first, always.
   - A user action commits to the local database and the UI updates from it. A sync record is queued separately. The user never waits for a round trip to see their own action.
   - **Done when:** every mutation succeeds and is visible with the network disabled.

2. Queue mutations durably.
   - The outbox survives app death and reboot. Each entry has a stable identifier so a retry cannot duplicate the server-side effect.
   - **Done when:** killing the app mid-sync loses nothing and duplicates nothing.

3. Decide the conflict rule per field, not per record.
   - Last-write-wins is acceptable for a note body and wrong for a counter or a set. State the rule for each field that can be edited on two devices.
   - **Done when:** every conflict-capable field has a stated resolution rule.

4. Sync incrementally.
   - Track a server cursor or updated-at watermark and request only what changed. A full re-fetch on every launch is slow, expensive and pointless.
   - **Done when:** a sync after a small change transfers a small amount of data.

5. Show sync state without blocking.
   - A subtle indicator for pending and failed items. A modal spinner over the whole screen defeats the entire design.
   - **Done when:** pending and failed states are visible and non-blocking.

6. Make failure recoverable by the user.
   - An item that fails permanently needs a visible retry or discard. Silent permanent failure loses user data without telling them.
   - **Done when:** a permanently failed mutation is surfaced with an action.

## Verification

- Every screen renders and every action succeeds in airplane mode.
- Reconnecting syncs the queue exactly once.
- Editing the same record on two devices resolves by the stated rule.
