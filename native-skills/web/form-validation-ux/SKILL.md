---
name: form-validation-ux
description: Build or fix a form. Use when validation fires on every keystroke, when errors are not associated with fields, or when a submit can be double-fired.
---

# Form Validation UX

## Timing is the whole design

Validate a field when the user LEAVES it, not while they are typing. Validating on every keystroke tells someone their email is invalid after the first character, which is both true and useless. Once a field has errored, re-validate on change so the error clears as soon as it is fixed.

## Workflow

1. Validate on the server regardless.
   - Client validation is a convenience. Anything that matters is enforced server-side, because the client is under the user's control.
   - **Done when:** every rule exists on the server, whether or not it also exists on the client.

2. Share one schema.
   - Define the rules once (Zod, Valibot, a JSON schema) and use them on both sides. Two hand-written copies drift, and the drift shows up as a form that submits and then fails.
   - **Done when:** changing a rule in one place changes both sides.

3. Wire errors to fields accessibly.
   - `aria-invalid` on the input, `aria-describedby` pointing at the message, and the message in a live region. An error rendered near the field but not associated with it is invisible to a screen reader.
   - **Done when:** a screen reader announces the error when focus enters the field.

4. Make submission safe.
   - Disable the submit while in flight and guard on the server with an idempotency key. A double-click on a slow network creates two orders.
   - **Done when:** double-submitting produces one result.

5. Never lose what was typed.
   - On a failed submit, keep every value and focus the first invalid field. Clearing a form on error is the fastest way to lose a user.
   - **Done when:** a failed submit preserves all input and moves focus to the first problem.

## Verification

- Submitting empty shows all errors at once, with focus on the first.
- Fixing a field clears its error immediately.
- Double-clicking submit produces one server-side effect.
- The whole form is completable by keyboard.
