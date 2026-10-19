---
name: room-and-persistence
description: Add or fix local persistence on Android. Use when adding a database, when a schema change crashes on upgrade, or when database work runs on the main thread.
---

# Room and Persistence

## Invariants

1. Every schema change needs a migration. Destructive fallback in a shipped app deletes the user's data.
2. No database access on the main thread. Room enforces this by default — that enforcement must not be disabled.
3. Queries return `Flow` so the UI updates when the data changes, rather than re-querying manually.

## Workflow

1. Commit the schema to version control.
   - Set the schema export directory. The exported JSON is what makes migrations testable and what tells a reviewer the schema changed.
   - **Done when:** the schema JSON is committed and updated with every version bump.

2. Write the migration with the version bump, in the same commit.
   - A version bump without a migration crashes every existing install on first launch. Automated migrations handle simple cases; anything renaming or transforming data needs an explicit one.
   - **Done when:** every version has a migration path from the previous one.

3. Test the migration against real data.
   - `MigrationTestHelper` creates the old schema, inserts rows, runs the migration and asserts on the result. An untested migration is a hypothesis.
   - **Done when:** a test migrates a populated old-version database and asserts the data survived.

4. Index what you filter and sort on.
   - Room warns about a missing index on a foreign key. A full table scan on a list screen is invisible on a test database and unusable at ten thousand rows.
   - **Done when:** every column in a WHERE or ORDER BY has an index, or its absence is justified.

5. Keep transactions narrow but complete.
   - Multi-step writes are annotated as a transaction so a crash cannot leave a half-state. Do not hold a transaction open across a network call.
   - **Done when:** no multi-step write can be interrupted into an inconsistent state.

## Verification

- Migration tests pass from every previous version.
- Strict mode reports no disk access on the main thread.
- A list screen with ten thousand rows scrolls smoothly.
