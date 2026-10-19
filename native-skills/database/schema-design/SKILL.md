---
name: schema-design
description: Design a database schema or add tables. Use when modelling new data, when a table has grown many nullable columns, or when queries need many joins to answer a simple question.
---

# Schema Design

## Workflow

1. Normalise first, denormalise on evidence.
   - Third normal form is the default. Denormalise only after a measured query problem, and write down which query justified it — otherwise the duplication outlives its reason and starts drifting.
   - **Done when:** every denormalised column names the query it exists for.

2. Choose keys deliberately.
   - A surrogate key (integer or UUIDv7) for identity, a unique constraint on the natural key for correctness. UUIDv4 as a clustered primary key destroys insert locality; UUIDv7 is time-ordered and does not.
   - **Done when:** every table has a primary key and a unique constraint on any natural identifier.

3. Let the database enforce the invariants.
   - NOT NULL, foreign keys, CHECK constraints, and unique indexes. An invariant enforced only in application code will be violated by a migration, a background job, or the second service that writes the table.
   - **Done when:** every stated invariant has a constraint, not just a validation.

4. Pick types precisely.
   - Timestamps with time zone, never a naive local time. Decimal for money, never floating point. An enumerated type or a CHECK for a fixed set, not free text.
   - **Done when:** no money column is floating point and no timestamp is zone-naive.

5. Treat many nullable columns as a modelling smell.
   - A table where different rows use different subsets of columns is usually several entities. Split it, or use a properly typed variant column.
   - **Done when:** each table has one clear meaning per row.

6. Plan for soft deletion or do not do it.
   - A `deleted_at` column means every query must filter on it, and one that forgets leaks deleted data. If you need it, add a view or partial indexes so the filter cannot be forgotten.
   - **Done when:** deleted rows cannot appear through a normal query path.

## Verification

- Every table has a primary key and appropriate foreign keys.
- Inserting data that violates a business rule is rejected by the database itself.
- A representative query runs without an unexpected join.
