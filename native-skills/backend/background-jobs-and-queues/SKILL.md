---
name: background-jobs-and-queues
description: Move work out of a request or add a job queue. Use when a request handler does slow work inline, when a job can be lost on restart, or when retries cause duplicate effects.
---

# Background Jobs and Queues

## The two properties that matter

Delivery is AT-LEAST-ONCE in every real queue, so every job must be idempotent. And a job that fails forever must end up somewhere a human will look, or it will fail silently for months.

## Workflow

1. Move only what is safe to defer.
   - The user must not need the result to complete their action. If they do, the work belongs in the request, and the fix is to make it faster.
   - **Done when:** the request returns something meaningful without waiting for the job.

2. Enqueue an identifier, never a payload.
   - Pass the record id and let the worker read the current state. A serialised payload is stale by the time it is processed, and it bloats the queue.
   - **Done when:** job arguments are identifiers and primitives only.

3. Make every handler idempotent.
   - Running twice must equal running once. Key side effects on a stable identifier, or record completion transactionally with the effect.
   - **Done when:** running the same job twice produces one effect, verified by test.

4. Set retry policy per failure class.
   - Transient (network, lock timeout): retry with exponential backoff and jitter. Permanent (validation, missing record): fail immediately to the dead-letter queue. Retrying a permanent failure burns capacity forever.
   - **Done when:** the handler distinguishes the two and behaves differently.

5. Give the dead-letter queue an owner.
   - Alert on its depth. A dead-letter queue nobody watches is a directory where work goes to be forgotten.
   - **Done when:** a non-zero depth raises an alert.

6. Enqueue only after the transaction commits.
   - Enqueuing inside a transaction that later rolls back leaves a job for a record that does not exist. Use a transactional outbox or an after-commit hook.
   - **Done when:** a rolled-back transaction enqueues nothing.

## Verification

- Running a job twice produces one effect.
- A permanently failing job reaches the dead-letter queue without retrying indefinitely.
- Killing a worker mid-job leaves the job re-runnable.
