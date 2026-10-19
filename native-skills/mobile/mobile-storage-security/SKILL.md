---
name: mobile-storage-security
description: Store sensitive data on a mobile device. Use when saving tokens, credentials, or personal data locally, or when a security review flags local storage.
---

# Mobile Storage Security

## The threat

A lost or stolen device, a backup extracted to a computer, and on a rooted or jailbroken device, another process reading your files. Plain preferences and plain files are readable in all three cases.

## Workflow

1. Classify before choosing storage.
   - Secrets (tokens, keys, passwords) → the platform keystore or keychain.
   - Personal data → encrypted database or encrypted files.
   - Cache and preferences → plain storage is fine.
   - **Done when:** every stored item has a classification.

2. Put secrets in hardware-backed storage.
   - The platform keystore keeps key material outside the app's address space, and hardware backing means it cannot be extracted even from a rooted device. Require user authentication for the highest-value keys.
   - **Done when:** no token or key is written to plain preferences or a plain file.

3. Never ship a secret inside the app.
   - An API key in the binary is extractable in minutes, whatever the obfuscation. If a key must exist, it belongs on a server that proxies the call.
   - **Done when:** no long-lived credential exists in the shipped artefact.

4. Control what leaves the device in a backup.
   - Exclude secrets and caches from automatic cloud backup explicitly. A backup restored to another device must not carry a session token.
   - **Done when:** the backup rules name what is excluded, and a restore does not carry a live session.

5. Protect data at rest as well as in transit.
   - Encrypted database for personal data, so a file pulled from a backup is not readable.
   - **Done when:** the database file alone is not readable without the device key.

6. Clear on logout.
   - Tokens, cached personal data and derived keys. Leaving them behind means the next user of the device inherits the session.
   - **Done when:** after logout, no personal data or credential remains on disk.

## Verification

- Pulling the app's data directory yields no readable secret.
- The shipped artefact contains no long-lived credential.
- Logout leaves no personal data on disk.
- A restored backup does not carry a live session.
