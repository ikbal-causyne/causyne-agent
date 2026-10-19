---
name: authorization-model
description: Decide who may do what. Use when adding permissions, when a user can access another user`s data, or when authorization checks are scattered across handlers.
---

# Authorization Model

## The distinction that gets missed

Authentication is who you are. Authorization is what you may do. A system with excellent authentication and no authorization lets any logged-in user read every record — and that class of bug (broken object-level authorization) is consistently the most common serious web vulnerability.

## Workflow

1. Check ownership on every single object access.
   - Not just on the list endpoint. `GET /orders/123` must verify that order 123 belongs to the caller. Relying on the UI not to show the link is not a control — the identifier is guessable and the endpoint is public.
   - **Done when:** every by-identifier endpoint verifies the caller's relationship to that object.

2. Deny by default.
   - The absence of a rule means no. A system where an unmatched route falls through to allow will leak on the first forgotten annotation.
   - **Done when:** a new endpoint with no rule is inaccessible.

3. Centralise the decision, distribute the enforcement.
   - One function answers "may this subject perform this action on this object". Handlers call it; they do not reimplement it. Scattered inline checks drift, and the one that drifts is the hole.
   - **Done when:** there is one authorization entry point and every handler uses it.

4. Enforce at the data layer where you can.
   - A query scoped to the caller's tenant by construction cannot leak, even from a handler that forgot to check. Row-level security or a mandatory scope on the repository turns a class of bug into an impossibility.
   - **Done when:** the default query path cannot return another tenant's rows.

5. Model roles as permissions, not as titles.
   - Check `may_refund_order`, not `is_admin`. Title checks scattered through the code make adding a role a codebase-wide change.
   - **Done when:** no branch tests a role name directly.

6. Log the denials.
   - A spike in denials is either a bug or an attack. Both are worth seeing.
   - **Done when:** denials are logged with subject, action and object.

## Verification

- A test attempts to read another user's object by identifier and receives 404 or 403.
- A new endpoint without a rule is denied.
- The default repository query is tenant-scoped.
