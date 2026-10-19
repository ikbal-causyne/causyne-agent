---
name: large-repository-surgery
description: Remove a large file or a secret from git history, or split a repository. Use when a clone is slow because of a committed binary, or when a credential must be purged from history.
---

# Large Repository Surgery

## Before anything else

Rewriting history breaks every existing clone. Everyone must re-clone or reset. Confirm the team knows, and if the goal is removing a secret, ROTATE THE SECRET FIRST — the rewrite does not reach forks, caches or anyone's existing clone.

## Workflow

1. Measure before you cut.
   - Find the largest objects in history and confirm they are what is actually causing the size.
   - `git count-objects -vH` gives the total; `git rev-list --objects --all` piped through `git cat-file --batch-check` and sorted by size gives the offenders.
   - **Done when:** you can name the paths responsible for most of the repository size.

2. Back up.
   - `git clone --mirror` to a separate location. A rewrite has no undo.
   - **Done when:** the mirror exists and `git log` in it shows the current history.

3. Rewrite with a purpose-built tool.
   - `git filter-repo` is the current tool. `filter-branch` is deprecated, orders of magnitude slower, and easy to get subtly wrong.
   - `git filter-repo --path secrets.env --invert-paths` removes a path from all history.
   - **Done when:** the path no longer appears in `git log --all -- <path>`.

4. Expire and collect.
   - The old objects are still reachable through the reflog until it is expired.
   - **Done when:** `git count-objects -vH` shows the reduced size.

5. Coordinate the push.
   - Force-push all branches and tags, then have everyone re-clone. Anyone who merges an old clone reintroduces the history.
   - **Done when:** every collaborator has confirmed a fresh clone.

## Prevention

- Add the file pattern to `.gitignore`.
- Use Git LFS for binaries that genuinely belong in the repository.
- Add a pre-commit size check.

## Verification

- The removed path is absent from `git log --all`.
- Repository size has dropped as expected.
- CI passes against the rewritten history.
