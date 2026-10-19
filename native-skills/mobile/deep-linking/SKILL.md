---
name: deep-linking
description: Implement deep links or universal links. Use when a link should open the app, when links open the browser instead, or when a link cannot restore a screen directly.
---

# Deep Linking

## Workflow

1. Use verified links, not custom schemes.
   - A custom scheme can be claimed by any app and does not work from most messaging clients. Verified HTTP links (app links / universal links) are owned by your domain and fall back to the web when the app is absent.
   - **Done when:** links use https and are verified against the domain.

2. Publish and verify the association file.
   - The association file must be served over https, with the right content type, no redirect, and the correct fingerprint or team identifier. Verification failing silently is the single most common cause of links opening the browser.
   - **Done when:** platform verification reports the domain as verified on a real device.

3. Make every screen reachable by URL.
   - Design the route table as URLs first. A screen that can only be reached by navigating from the home screen cannot be linked, notified into, or restored.
   - **Done when:** every meaningful screen has a URL.

4. Rebuild the back stack, do not just push.
   - Opening a detail screen from a link with an empty back stack traps the user. Synthesise the parent chain so back goes somewhere sensible.
   - **Done when:** pressing back from a linked screen reaches a reasonable parent, not an exit.

5. Handle the pre-ready link.
   - A link can arrive before authentication or before data is loaded. Store the pending destination, complete the prerequisite, then navigate. Never drop it.
   - **Done when:** a link that requires login lands on the target after login, not on the home screen.

6. Validate the parameters.
   - A link is untrusted input. Validate identifiers and reject anything malformed rather than passing it into a query.
   - **Done when:** a malformed link shows an error rather than crashing.

## Verification

- Links open the app from a message, a browser and a notification, on a real device.
- Back from a linked screen behaves correctly.
- A link requiring authentication survives the login flow.
- A malformed link fails safely.
