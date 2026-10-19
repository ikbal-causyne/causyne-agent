---
name: commit-hygiene
description: Structure commits and write commit messages. Use when a change is being committed, when a branch has a messy history before review, or when a message says only "fix".
---

# Commit Hygiene

## What a commit is for

A commit is a message to whoever runs `git blame` on this line in two years. It should say WHY, because the diff already says what.

## Workflow

1. One commit, one logical change.
   - A refactor and a behaviour change in one commit cannot be reviewed or reverted separately. Split them.
   - `git add -p` stages hunks rather than whole files.
   - **Done when:** each commit could be reverted alone without breaking the build.

2. Write the subject as an instruction.
   - Imperative mood, under about seventy characters, no trailing period: `fix race in session close`, not `fixed a race` or `fixing races`.
   - **Done when:** the subject completes the sentence "if applied, this commit will …".

3. Use the body for the why.
   - What was wrong, why this approach, what was considered and rejected. Reference the issue.
   - Skip the body only when the subject is genuinely complete.
   - **Done when:** a reader who disagrees with the change knows what to argue with.

4. Never commit noise.
   - Debug prints, commented-out code, unrelated formatting, generated files that should be ignored.
   - `git diff --cached` before every commit.
   - **Done when:** every line in the staged diff is intentional.

5. Clean the branch before review.
   - Squash the "fix typo" commits into what they fix. Do this only on a branch nobody else has pulled.
   - **Done when:** the branch reads as a sequence of deliberate steps.

## Verification

- `git log --oneline origin/main..HEAD` reads as a coherent narrative.
- No commit message is a single word.
- `git diff origin/main...HEAD` contains no debug output or unrelated reformatting.
