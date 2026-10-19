---
name: input-validation-and-injection
description: Handle data that came from a user, a request, or a third party. Use when building a query, a command, a template, or a path from external input.
---

# Input Validation and Injection

## The single principle

Never build a command out of a string containing untrusted data. Every injection class — SQL, shell, template, path, header, log — is the same mistake: data crossing into a position where it is read as instructions.

## By interpreter

- **SQL** — parameterised queries only. Bind the value; never interpolate. Identifiers that must be dynamic come from an allowlist, because they cannot be bound.
- **Shell** — pass an argument array to the spawn API, never a joined string, and never through a shell. Where a shell is unavoidable, an allowlist of complete commands is the only safe form.
- **Path** — resolve, then verify the result is inside the permitted root. `../` traversal survives naive prefix checks and survives decoding twice.
- **HTML** — contextual escaping, applied by the template engine. Never build markup by concatenation. Untrusted markup goes through a sanitiser with an allowlist.
- **Headers and logs** — strip carriage returns and newlines. A newline in a header splits the response; in a log it forges an entry.
- **Deserialisation** — never deserialise untrusted data into arbitrary types. Parse into a declared schema.

## Workflow

1. Map every entry point.
   - Request bodies, query strings, headers, cookies, uploads, webhooks, environment, third-party API responses, and data read back from your own database that was written by a user.
   - **Done when:** every source of external data is listed.

2. Validate on the way in, against a schema.
   - Type, range, length, format, and an allowlist where the set is finite. Reject rather than sanitise: sanitising guesses at intent and is bypassable.
   - **Done when:** every entry point parses into a validated type before use.

3. Escape on the way out, per context.
   - The same value needs different escaping in HTML, in an attribute, in JavaScript, in a URL. One "escape" function applied everywhere is wrong in at least three of those.
   - **Done when:** escaping is applied by the sink, matched to the sink.

4. Enforce size limits everywhere.
   - Body size, field length, array length, upload size, and nesting depth. Without them, one request exhausts memory.
   - **Done when:** every unbounded input has a stated limit.

## Verification

- No query, command, or path is built by string concatenation with external data.
- Traversal payloads are rejected.
- A newline in a header value does not split the response.
- Oversized input is rejected before allocation.
