---
name: secret-management
description: Handle credentials, API keys, or certificates in an application or pipeline. Use when a secret appears in a config file, in an environment file committed to the repository, or in CI logs.
---

# Secret Management

## Invariants

1. A secret in version control is compromised, including in deleted files — history retains it. Rotate it; do not merely delete it.
2. Secrets reach the process through the environment or a mounted file, injected at runtime by a secret store. Never through the image, the repository, or the build args.
3. Every secret has a rotation path. One that cannot be rotated is a permanent liability.

## Workflow

1. Find what is already exposed.
   - Search the working tree and the history for key-shaped strings: long base64 or hex runs, `-----BEGIN`, and assignments to names containing key, token, secret, or password.
   - **Done when:** you have a list of every exposure, with the file and the commit.

2. Rotate before you clean.
   - Cleaning history without rotating leaves a live credential in every existing clone and in every fork.
   - **Done when:** the old value is revoked at the provider.

3. Move the value to a store.
   - Cloud secret manager, or the platform's own secret object. Reference it by name from config; never inline it.
   - **Done when:** the repository contains the secret's NAME and never its value.

4. Block the next one.
   - Add a pre-commit secret scan and a `.gitignore` entry for the environment file. Commit an example file with placeholder values so the shape is documented without the values.
   - **Done when:** a test commit containing a fake key is rejected locally.

5. Mask in CI.
   - Register every secret with the CI provider so it is masked in logs. A secret echoed by a debug command is a public secret on a public repository.
   - **Done when:** a deliberate echo of the secret shows as a mask in the run log.

## Verification

- No key-shaped string survives in the working tree.
- The application starts with values supplied only by the environment.
- A commit containing a fake credential is rejected by the local hook.
