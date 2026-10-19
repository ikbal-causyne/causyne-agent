---
name: authentication-and-sessions
description: Implement login, sessions, or token handling. Use when authentication is being added, when tokens are stored in local storage, or when passwords are being hashed.
---

# Authentication and Sessions

## Non-negotiables

1. Passwords are hashed with a memory-hard function — argon2id, or bcrypt where argon2 is unavailable. Never a general-purpose hash, salted or not: those are designed to be fast, which is precisely the wrong property.
2. Tokens live in `HttpOnly`, `Secure`, `SameSite` cookies. A token in local storage is readable by any script on the page, which turns any cross-site scripting bug into full account takeover.
3. Every authentication decision happens on the server. A client-side check is a display convenience, never a control.

## Workflow

1. Use a library or a provider.
   - Authentication has many correct-looking implementations that are subtly broken. Prefer an established library or an identity provider over hand-rolling.
   - **Done when:** the approach is named and its security assumptions are stated.

2. Get session lifetime right.
   - Short-lived access token, longer-lived refresh token, and rotation on every refresh. Detect reuse of a rotated refresh token and revoke the whole family — that is the signal a token was stolen.
   - **Done when:** replaying an old refresh token invalidates the session.

3. Make logout actually revoke.
   - A stateless token cannot be revoked, so either keep server-side session state or maintain a denylist until expiry. Deleting the cookie alone leaves a valid token in the attacker's hands.
   - **Done when:** a captured token stops working after logout.

4. Rate-limit and lock out.
   - Per-account and per-address limits on login and on password reset. Without them, credential stuffing runs unimpeded.
   - **Done when:** repeated failures are throttled and the throttle is tested.

5. Keep the error messages uniform.
   - "Invalid email or password" for both cases. Distinguishing them enumerates accounts. The same applies to password reset: always report that a mail was sent.
   - **Done when:** the response and its timing are the same for a known and an unknown account.

6. Regenerate the session identifier on privilege change.
   - On login and on role elevation. Without this, an identifier planted before login remains valid after it.
   - **Done when:** the identifier differs before and after login.

## Verification

- Password hashes use a memory-hard function with sensible parameters.
- The auth cookie has HttpOnly, Secure and SameSite set.
- A revoked refresh token fails and invalidates its family.
- Login responses are indistinguishable for unknown and wrong-password accounts.
