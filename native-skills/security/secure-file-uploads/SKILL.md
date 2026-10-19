---
name: secure-file-uploads
description: Accept file uploads from users. Use when adding an upload feature, or when uploaded files are served back to users.
---

# Secure File Uploads

## Why this is its own topic

An upload endpoint lets a stranger place a file of their choosing on your infrastructure. The failure modes span storage exhaustion, remote code execution, stored cross-site scripting, and server-side request forgery — and the naive implementation hits several of them.

## Workflow

1. Limit size before reading.
   - Enforce at the reverse proxy AND in the application. Streaming a body into memory to check its length is already the denial of service.
   - **Done when:** an oversized upload is rejected before the body is buffered.

2. Determine the type from the content, not the name.
   - Read the magic bytes. The extension and the declared content type are both attacker-controlled. Validate against an allowlist of types you actually support — never a denylist.
   - **Done when:** a file renamed to a permitted extension is rejected on its real content.

3. Never use the supplied filename.
   - Generate your own identifier and store the original name only as a display label. The supplied name can contain traversal sequences, null bytes, or a name that means something to the filesystem.
   - **Done when:** the stored path is derived entirely from server-generated values.

4. Store outside the web root, and serve deliberately.
   - Files in a served directory can be requested directly, which turns an uploaded script into an executed one. Store in object storage or outside the root, and serve through a handler that sets the content type and `Content-Disposition: attachment`, plus `X-Content-Type-Options: nosniff`.
   - **Done when:** an uploaded HTML file downloads rather than renders.

5. Serve user content from a separate origin.
   - Same-origin user content means a served file can script against your session. A distinct domain contains it.
   - **Done when:** user uploads are served from a domain that holds no session.

6. Process images out-of-process and re-encode.
   - Image parsers are a large attack surface. Re-encoding strips embedded payloads and metadata, including location data users did not intend to share.
   - **Done when:** stored images are re-encoded and stripped of metadata.

7. Scan, and quarantine until clean.
   - **Done when:** a file is unreachable until it has passed scanning.

## Verification

- An oversized upload is rejected early.
- A renamed executable is rejected on content inspection.
- An uploaded HTML file downloads rather than executes.
- Uploaded images carry no location metadata.
