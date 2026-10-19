---
name: push-notifications
description: Implement push notifications. Use when adding push, when notifications do not arrive on some devices, or when permission is requested at launch.
---

# Push Notifications

## Workflow

1. Ask for permission in context, never at launch.
   - A permission prompt on first open is denied by most users, and on both platforms a denial is close to permanent. Ask at the moment the value is obvious, after explaining it in your own UI first.
   - **Done when:** the system prompt appears only after an in-app explanation and a user action.

2. Treat the token as volatile.
   - It rotates on reinstall, restore, and sometimes on update. Refresh on every launch and on the rotation callback, and send it to the server with a device identifier so old tokens can be replaced rather than accumulated.
   - **Done when:** reinstalling produces a working token without a duplicate device record.

3. Send data, render locally.
   - A notification payload containing final display text cannot be localised, personalised, or deduplicated. Send identifiers and render from local data where the platform allows.
   - **Done when:** the notification respects the device language and the app's current state.

4. Handle all three app states.
   - Foreground, background, and terminated behave differently on both platforms. The terminated case is the one that is usually missed, and it is the one that matters for a cold launch from a notification.
   - **Done when:** tapping a notification opens the right screen from all three states.

5. Route the tap deterministically.
   - The payload carries a deep link. Handle a link that arrives before the app is ready by queueing it until navigation exists.
   - **Done when:** a cold-start notification tap lands on the correct screen.

6. Respect the user's attention.
   - Channels or categories so the user can mute a class rather than all notifications. Collapse keys so ten updates do not become ten notifications. Never send a notification with no user value.
   - **Done when:** every notification type is in a channel the user can control separately.

## Verification

- Delivery works in foreground, background and terminated states on physical devices.
- Reinstalling refreshes the token and does not duplicate the device.
- Muting one channel leaves the others working.
