---
name: lifecycle-and-leaks
description: Fix an Android memory leak or lifecycle crash. Use when the app crashes after rotation, when a callback fires on a destroyed component, or when memory grows across navigations.
---

# Android Lifecycle and Leaks

## What leaks

Anything long-lived holding a reference to anything short-lived. An activity is short-lived — it dies on every rotation. A singleton, a static field, a running coroutine, or a registered listener that outlives it keeps the whole view tree in memory.

## The recurring causes

1. A non-static inner class or a lambda capturing the activity, held by something longer-lived.
2. A listener or receiver registered and never unregistered.
3. A coroutine launched in a scope that is never cancelled.
4. A singleton constructed with the activity context instead of the application context.
5. A handler with a delayed message posted from a destroyed component.

## Workflow

1. Confirm the leak before theorising.
   - LeakCanary in debug names the retaining chain. The chain is the answer; guessing from the symptom rarely is.
   - **Done when:** you have the retaining reference chain.

2. Match the scope to the lifetime.
   - `lifecycleScope` for work tied to the screen, `viewModelScope` for work tied to the ViewModel, and `repeatOnLifecycle(STARTED)` for collecting a flow only while visible. Collecting a flow in `onCreate` without it keeps collecting behind a locked screen.
   - **Done when:** every coroutine and every collection is bound to a lifecycle.

3. Pair every registration with a removal.
   - Register in `onStart`, unregister in `onStop`. Or use a `DefaultLifecycleObserver` so the pairing cannot be forgotten.
   - **Done when:** every registration has a matching removal in the symmetric callback.

4. Pick the right context.
   - Application context for anything stored beyond a screen. Activity context only for UI: inflating, theming, dialogs.
   - **Done when:** no long-lived object holds an activity context.

5. Never hold a view reference past the view's life.
   - In a fragment, null the binding in `onDestroyView`. The fragment outlives its view, and that gap is where the classic fragment leak lives.
   - **Done when:** the binding is nulled and access after destruction is impossible.

## Verification

- LeakCanary reports no leak after rotating and navigating repeatedly.
- Memory returns to baseline after navigating away and forcing a collection.
- No crash after rotating during an in-flight network call.
