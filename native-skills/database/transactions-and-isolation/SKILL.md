---
name: transactions-and-isolation
description: Reason about database transactions or fix a concurrency bug. Use when two operations interfere, when a balance or counter goes wrong under load, or when deadlocks appear.
---

# Transactions and Isolation

## What the default does not protect you from

Most databases default to read committed. That prevents dirty reads and nothing else. Under it, a read-then-write sequence is a race: two transactions both read the old value, both write, and one update vanishes. Almost every "the counter is wrong" bug is this.

## Workflow

1. Identify read-modify-write sequences.
   - Any code that SELECTs a value, computes from it, and UPDATEs. These are the races.
   - **Done when:** every such sequence is listed.

2. Fix each one with the cheapest sufficient tool.
   - **Atomic update:** `UPDATE ... SET n = n + 1` — no read, no race. Always prefer this.
   - **Pessimistic lock:** `SELECT ... FOR UPDATE` — locks the row for the transaction. Correct, and it serialises.
   - **Optimistic lock:** a version column, and `UPDATE ... WHERE version = ?` with a retry on zero rows. Best under low contention.
   - **Serializable isolation:** the database detects the anomaly and aborts one transaction. Correct and simple, but you MUST handle the serialisation failure by retrying.
   - **Done when:** each sequence uses one of these and the choice is stated.

3. Keep transactions short and free of external calls.
   - A network request inside a transaction holds locks for the duration of someone else's outage. Do the external work outside and commit the result.
   - **Done when:** no transaction contains a network call.

4. Order locks consistently to avoid deadlocks.
   - A deadlock is two transactions taking the same locks in different orders. Always acquire in a fixed order — by primary key, for example.
   - **Done when:** every multi-row write takes locks in a defined order.

5. Retry serialisation and deadlock failures.
   - These are expected, not exceptional. Retry with backoff, with a bounded count.
   - **Done when:** the retry path exists and is tested.

## Verification

- A concurrency test with many parallel workers produces the correct final value.
- No transaction performs I/O outside the database.
- Deadlock and serialisation failures are retried rather than surfaced.
