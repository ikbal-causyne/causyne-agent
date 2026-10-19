---
name: rest-api-design
description: Design or review an HTTP API. Use when endpoints are being added, when responses are inconsistent, or when clients need to special-case error handling.
---

# REST API Design

## Workflow

1. Model resources, not actions.
   - `POST /orders`, not `POST /createOrder`. The verb is the method. When an operation genuinely is not a resource change (`/search`, `/reindex`), say so explicitly rather than contorting a noun.
   - **Done when:** every path is a noun and every method carries the verb.

2. Use status codes the way clients expect.
   - 200 with a body, 201 with a `Location`, 204 with none. 400 malformed, 401 unauthenticated, 403 authenticated but not permitted, 404 absent, 409 conflict, 422 semantically invalid, 429 rate-limited.
   - Never return 200 with an error inside the body. Every client's error handling depends on the status.
   - **Done when:** no successful-looking status carries an error payload.

3. Give errors one shape.
   - A stable machine-readable code, a human message, and a field-level detail list where relevant. RFC 9457 problem details is a reasonable default.
   - Never leak a stack trace or an internal identifier to a client.
   - **Done when:** every error response validates against one schema.

4. Paginate every collection from day one.
   - Cursor-based, not offset-based: offset pagination skips and repeats rows when the underlying data changes between pages. An unpaginated list endpoint is an outage waiting for the table to grow.
   - **Done when:** every collection endpoint has a documented limit and cursor.

5. Version before you need to.
   - A path prefix (`/v1/`) is the simplest thing that works. Adding a version after clients exist is far harder than starting with one.
   - **Done when:** every route carries a version.

6. Make writes idempotent.
   - PUT and DELETE are idempotent by definition. POST needs an `Idempotency-Key` header if a retry must not duplicate the effect — and clients on flaky networks WILL retry.
   - **Done when:** replaying a write with the same key produces one effect.

## Verification

- An OpenAPI document describes every route and matches the implementation.
- Every error path returns the shared error shape with the correct status.
- Replaying a POST with the same idempotency key creates one record.
