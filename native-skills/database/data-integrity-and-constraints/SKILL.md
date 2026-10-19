---
name: data-integrity-and-constraints
description: Enforce correctness rules in a database. Use when invalid data has been found in production, when rules live only in application code, or when several services write the same table.
---

# Data Integrity and Constraints

## Where the rules belong

In the database. Application-level validation is a user-experience feature; it is bypassed by every migration, every background job, every admin script, and every other service that writes the table. If a rule matters, the database enforces it.

## Workflow

1. Find what is already invalid.
   - Write the constraint as a SELECT first and count the violations. There are almost always some, and adding the constraint blind will fail the migration.
   - **Done when:** the current violation count is known for each intended constraint.

2. Clean the existing data before constraining.
   - Decide per violation class: fix, delete, or quarantine. Record the decision — this is a data change, not a schema change.
   - **Done when:** the violation count is zero.

3. Add the constraint at the right level.
   - NOT NULL for required. UNIQUE for identity. FOREIGN KEY for references, with an explicit ON DELETE rule — the default is usually not what you want. CHECK for value rules. EXCLUDE for non-overlap, such as bookings.
   - **Done when:** every rule has a constraint of the appropriate kind.

4. Choose referential actions deliberately.
   - CASCADE deletes children silently — powerful and dangerous. RESTRICT is the safe default. SET NULL requires the column to be nullable and the meaning of null to be defined.
   - **Done when:** every foreign key states its action and the reason.

5. Add constraints without locking.
   - NOT VALID first, then VALIDATE separately. This avoids a full table scan under an exclusive lock.
   - **Done when:** the constraint is added and validated without a long lock.

6. Test that the constraint actually fires.
   - Write a test that attempts the invalid write and asserts the failure. An untested constraint may be disabled or wrong.
   - **Done when:** a test proves invalid data is rejected.

## Verification

- Every stated business rule maps to a database constraint.
- A test attempts each invalid write and confirms rejection.
- The constraints were added without a long lock on a production-scale copy.
