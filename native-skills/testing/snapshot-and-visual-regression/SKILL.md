---
name: snapshot-and-visual-regression
description: Use snapshot or visual regression tests. Use when UI changes break silently, when snapshots are updated without review, or when a large snapshot file has appeared.
---

# Snapshot and Visual Regression Testing

## The failure mode of snapshots

They are trivial to update. When a snapshot fails, the fastest action is to accept the new one, and that becomes reflexive — at which point the snapshot records what the code does rather than what it should do, and catches nothing.

## Workflow

1. Snapshot small, meaningful units.
   - A component's rendered output, a serialised payload, a formatted error. Never a whole page — a large snapshot fails on every unrelated change and is never actually read.
   - **Done when:** every snapshot is small enough to review in a diff.

2. Review every snapshot change deliberately.
   - The diff is the test result. Accepting it without reading is the same as deleting the test.
   - **Done when:** each snapshot change in a review has a stated reason.

3. Remove non-determinism before snapshotting.
   - Timestamps, identifiers, ordering, and floating-point formatting. Replace them with stable placeholders — otherwise the snapshot fails randomly and gets updated reflexively.
   - **Done when:** ten consecutive runs produce identical snapshots.

4. Render visual tests in a controlled environment.
   - A container with pinned fonts and a fixed device pixel ratio. Font rendering differs between operating systems, so screenshots taken on a laptop will never match CI.
   - **Done when:** the same commit produces identical screenshots locally and in CI.

5. Set a sensible pixel tolerance.
   - Zero tolerance flags anti-aliasing noise. Too high hides real regressions. Tune it against a known-good pair.
   - **Done when:** the threshold catches a one-pixel layout shift but ignores anti-aliasing.

6. Prefer explicit assertions where they are clearer.
   - "The submit button is disabled" is a better test than a snapshot containing a disabled attribute somewhere. Reach for snapshots when the output is large and the shape is the point.
   - **Done when:** behavioural rules are asserted explicitly, not implied by a snapshot.

## Verification

- Ten runs produce no spurious diff.
- Local and CI screenshots match on the same commit.
- Each snapshot is small enough to review.
