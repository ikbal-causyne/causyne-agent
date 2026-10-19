---
name: branch-strategy
description: Set up or repair a branching model for a team. Use when merges are painful, when long-lived branches diverge badly, or when there is no agreement on where releases come from.
---

# Branch Strategy

## The bias

Prefer short-lived branches off a single main line. Almost every branching pain is a symptom of branches living too long, and no model fixes that.

## Workflow

1. Establish one source of truth.
   - `main` is always releasable. Everything branches from it and merges back into it.
   - **Done when:** there is exactly one branch nobody force-pushes.

2. Keep feature branches short.
   - Under a few days. Anything longer merges into a codebase it no longer recognises. Split the work and use a feature flag if the feature is not ready to be seen.
   - **Done when:** the median open branch age is measured in days, not weeks.

3. Choose integration direction deliberately.
   - Rebase a private branch onto main to keep history linear. Merge a shared branch, because rebasing rewrites commits other people have.
   - **Done when:** the rule is written down and matches what people actually do.

4. Protect the main line mechanically.
   - Require review, require CI, forbid force-push. A convention nobody enforces is a convention nobody follows.
   - **Done when:** a direct push to main is rejected by the server.

5. Tag releases; do not branch them.
   - A tag is an immutable pointer. A release branch is a second main line that will drift.
   - Branch a release only to backport a fix to a version that is still supported.
   - **Done when:** every shipped version corresponds to a tag.

## Verification

- Branch protection rejects a direct push and an unreviewed merge.
- The oldest open feature branch is days old, not months.
- Every release in the changelog has a matching tag.
