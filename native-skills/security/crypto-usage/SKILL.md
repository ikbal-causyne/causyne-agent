---
name: crypto-usage
description: Encrypt, hash, sign, or generate randomness. Use whenever cryptography is being written or reviewed.
---

# Cryptography Usage

## The rule

Do not build it. Use a vetted library at the highest level of abstraction available. Cryptographic code fails silently — it produces output that looks correct and provides no security — so "it works" tells you nothing.

## The correct primitives

- **Password storage** — argon2id, or bcrypt. Never a general-purpose hash: they are fast by design, which is exactly wrong here.
- **Symmetric encryption** — an authenticated mode: AES-GCM or XChaCha20-Poly1305. Unauthenticated encryption is malleable, and the attack is practical.
- **Random values** — the platform's cryptographically secure generator. Never a general-purpose random function for a token, an identifier, or a nonce.
- **Comparing secrets** — constant-time comparison. A normal comparison returns early on the first differing byte and leaks the secret through timing.
- **Signing** — Ed25519, or ECDSA on P-256. Verify with the algorithm you expect, never with the one named in the token.
- **Key derivation** — HKDF from a high-entropy secret, argon2 or scrypt from a password.

## Workflow

1. State what you are protecting against.
   - Encryption at rest protects a stolen disk, not a compromised application. Naming the threat prevents solving the wrong problem.
   - **Done when:** the threat and what the mechanism does not cover are both written down.

2. Never reuse a nonce with a key.
   - Nonce reuse in GCM is catastrophic — it reveals the plaintext relationship and the authentication key. Generate randomly, or use a counter that provably never repeats. XChaCha20's larger nonce makes random generation safe.
   - **Done when:** nonce generation is shown never to repeat for a given key.

3. Plan key rotation from the start.
   - Store a key identifier with the ciphertext so old data stays readable while new data uses a new key. Retrofitting this requires decrypting everything.
   - **Done when:** ciphertext carries a key identifier.

4. Keep keys out of the application.
   - A key management service or the platform keystore. A key in the environment is a key in every crash dump, log aggregator, and process listing.
   - **Done when:** no key material appears in source, config, or environment.

5. Verify before you use.
   - Check the authentication tag or signature BEFORE decrypting or parsing. Acting on unverified data is the whole vulnerability.
   - **Done when:** every verification precedes every use.

## Verification

- No hand-rolled primitive exists.
- Secret comparison is constant-time.
- Nonce generation cannot repeat.
- Keys are external to the application and rotatable.
