---
name: security-headers-and-csp
description: Configure HTTP security headers or a Content Security Policy. Use when hardening a web application, or when a security scan reports missing headers.
---

# Security Headers and CSP

## The headers that matter, in order of value

1. **Content-Security-Policy** — the only one that meaningfully mitigates cross-site scripting. Also the only one requiring real work.
2. **Strict-Transport-Security** — forces https for a long max-age. Include subdomains once you are sure.
3. **X-Content-Type-Options: nosniff** — stops the browser guessing a content type, which is how an uploaded text file becomes a script.
4. **Referrer-Policy: strict-origin-when-cross-origin** — stops paths and query strings leaking to third parties.
5. **X-Frame-Options / frame-ancestors** — clickjacking. Prefer the CSP directive.
6. **Permissions-Policy** — deny camera, microphone and geolocation unless used.

## Workflow

1. Deploy CSP in report-only mode first.
   - A strict policy applied directly will break the site. Report-only collects violations without enforcing, and the report tells you what the site actually depends on.
   - **Done when:** a week of reports has been collected and reviewed.

2. Build the policy from a nonce, not from an allowlist.
   - Host allowlists are routinely bypassable through a permitted CDN. A per-response nonce with `strict-dynamic` is the current guidance and is far more robust.
   - **Done when:** the policy uses a per-response nonce and no host wildcard.

3. Remove what the policy forbids, rather than weakening the policy.
   - Inline handlers and inline styles are what force `unsafe-inline`, and `unsafe-inline` removes most of the protection. Move them to files or nonce them.
   - **Done when:** the policy contains no `unsafe-inline` and no `unsafe-eval`.

4. Keep a reporting endpoint after enforcement.
   - Violations in production are either a bug you introduced or an injection attempt. Both are worth seeing.
   - **Done when:** violations continue to be collected after enforcement begins.

5. Set the headers at one layer.
   - The reverse proxy or a single middleware. Headers set in several places conflict, and the browser takes the most restrictive — usually not the one you were reading.
   - **Done when:** each header is emitted exactly once.

## Verification

- An observatory or header scan reports no missing header.
- The CSP contains no `unsafe-inline`, no `unsafe-eval`, and no wildcard host.
- An injected inline script is blocked and reported.
- Every response carries each header exactly once.
