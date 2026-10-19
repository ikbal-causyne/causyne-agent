---
name: history-recovery
description: Recover lost commits or undo a destructive git operation. Use after a bad reset, a deleted branch, a force-push over someone else`s work, or an amended commit that ate a change.
---

# History Recovery

## The fact that makes recovery possible

Git almost never deletes a commit immediately. A commit that nothing references is unreachable, not gone, and stays in the object store until garbage collection runs — usually weeks. `git reflog` is the index of where HEAD has been.

## Workflow

1. Stop and take a snapshot.
   - Do not run further git commands that move HEAD. Copy the whole working directory first if the state is valuable.
   - **Done when:** a copy of the current directory exists outside the repository.

2. Find the lost commit in the reflog.
   - `git reflog` for HEAD, `git reflog show <branch>` for a specific branch.
   - Each entry has a hash. The one just before the destructive command is what you want.
   - **Done when:** you have the hash and have confirmed it with `git show <hash>`.

3. Recover without overwriting.
   - Prefer a new branch: `git branch recovered <hash>`. This is non-destructive and inspectable.
   - Only after inspection: `git reset --hard <hash>` on the original branch.
   - **Done when:** the recovered content is visible on a branch and verified with `git log`.

4. If the reflog is empty, search unreachable objects.
   - `git fsck --lost-found --unreachable` lists dangling commits. `git show` each candidate.
   - **Done when:** the content is found, or you can state that it never reached the object store.

## The specific disasters

- **Bad `reset --hard`:** the previous HEAD is the reflog entry above the reset.
- **Deleted branch:** `git reflog show` no longer works, but the branch tip is still in `git reflog` under HEAD, or in `fsck --unreachable`.
- **Bad `commit --amend`:** the pre-amend commit is one reflog entry back.
- **Force-push over a colleague:** the old remote tip is in their local reflog, and in the remote's reflog if you have server access. Ask before rewriting again.
- **Detached HEAD with commits:** `git branch <name> HEAD` before checking anything else out.

## Verification

- `git log --oneline` on the recovered branch shows the missing commits.
- The files that were lost are present with the expected content.
- Nothing else moved: `git status` is clean.
