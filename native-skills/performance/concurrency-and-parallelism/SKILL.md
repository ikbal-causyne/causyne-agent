---
name: concurrency-and-parallelism
description: Make code faster by running work concurrently, or fix a concurrency bug. Use when work is serialised unnecessarily, or when parallel code produces wrong results.
---

# Concurrency and Parallelism

## The distinction that decides the mechanism

Concurrency is dealing with many things at once; parallelism is doing many things at once. I/O-bound work needs concurrency — async or threads. CPU-bound work needs parallelism — processes or real threads. Applying the wrong one gives no speedup and sometimes a slowdown.

## Workflow

1. Classify the bottleneck before choosing a tool.
   - Watch CPU during the slow operation. Near 100% on one core is CPU-bound. Low CPU with the process waiting is I/O-bound.
   - **Done when:** the bottleneck is classified with a measurement.

2. Find the actual serialisation point.
   - Parallelising around a shared lock, a single database connection, or a rate-limited API gives no improvement — the queue just moves. Find what everything waits on.
   - **Done when:** the shared resource is identified and shown not to be the limit.

3. Bound the concurrency.
   - Unbounded parallelism exhausts connections, file descriptors, or memory, and usually performs worse than a sensible limit. Use a semaphore or a worker pool sized from measurement.
   - **Done when:** peak concurrency is capped at a measured number.

4. Eliminate shared mutable state, do not lock it.
   - Give each worker its own data and combine at the end. Locks are correct and slow, and every lock is a potential deadlock. Immutability and message passing avoid the whole class.
   - **Done when:** workers share nothing mutable, or every shared item's protection is documented.

5. Order lock acquisition consistently.
   - Deadlock is two paths taking the same locks in different orders. A global order — by identifier — removes it structurally.
   - **Done when:** every multi-lock path acquires in the same order.

6. Test under real contention.
   - A race that never appears with two workers appears with two hundred. Run the concurrency test with many workers, repeatedly, and with a race detector where the language has one.
   - **Done when:** a high-contention test passes repeatedly.

## Verification

- Speedup is measured, not assumed, and is close to what the bottleneck class predicts.
- A high-contention test produces the correct result over many runs.
- No shared mutable state is accessed without documented protection.
