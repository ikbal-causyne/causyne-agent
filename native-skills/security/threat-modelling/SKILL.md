---
name: threat-modelling
description: Assess the security of a feature or system. Use before building anything that handles money, personal data, or authentication, and during a security review.
---

# Threat Modelling

## The four questions

What are we building, what can go wrong, what will we do about it, and did we do a good job. Everything else is elaboration.

## Workflow

1. Draw the data flow.
   - Components, data stores, external entities, and the trust boundaries between them. A boundary is anywhere data crosses from less trusted to more trusted — that is where controls belong and where they are usually missing.
   - **Done when:** every trust boundary in the feature is marked.

2. Enumerate threats per boundary.
   - Walk the categories: spoofing identity, tampering with data, repudiation, information disclosure, denial of service, elevation of privilege. Apply each to each boundary rather than brainstorming freely — free brainstorming misses whole categories.
   - **Done when:** every boundary has been walked through all six.

3. Rank by realistic impact and likelihood.
   - Not everything gets fixed. Say which are accepted and why, and record the acceptance.
   - **Done when:** each threat is mitigated, transferred, or accepted in writing.

4. Name a specific control per mitigated threat.
   - "Validate input" is not a control. "Reject requests whose body exceeds 1MB at the reverse proxy" is.
   - **Done when:** every mitigation names a concrete, testable mechanism.

5. Test the controls.
   - A control nobody attempted to bypass is a hypothesis. Write the test that tries.
   - **Done when:** each control has a test attempting to defeat it.

## The threats people forget

- The admin interface, which usually has weaker controls than the user-facing one.
- The background job, which often runs with elevated privilege and no authorization check.
- The error path, which frequently leaks internal detail.
- The third-party integration, which is trusted implicitly.
- The recovery flow, which is frequently weaker than the login it can bypass.

## Verification

- A diagram exists with boundaries marked.
- Every boundary has been walked through all six categories.
- Every mitigation names a mechanism and has a test.
