---
name: async-correctness
description: Write or debug asyncio code. Use when async code runs slower than sync, when a coroutine is never awaited, or when the event loop appears to block.
---

# Asyncio Correctness

## The failure that causes most of the others

A blocking call inside a coroutine stops the ENTIRE event loop, not just that task. `time.sleep`, `requests.get`, a synchronous file read, or a CPU-heavy loop will serialise everything the program is doing. Async code that is slower than sync code almost always has one of these.

## Workflow

1. Find the blocking calls.
   - Any synchronous I/O library, any `time.sleep`, any long pure-Python computation.
   - Fix: use the async equivalent (`httpx` over `requests`, `aiofiles` or a thread for files), or push the work off the loop with `asyncio.to_thread` for I/O and a process pool for CPU.
   - **Done when:** no coroutine performs synchronous I/O or long computation.

2. Make concurrency explicit.
   - `await` in sequence is sequential. To run concurrently, use `asyncio.TaskGroup` (3.11+), which also propagates exceptions and cancels siblings correctly.
   - `asyncio.gather` without `return_exceptions` leaves siblings running after one fails.
   - **Done when:** work intended to be concurrent uses a TaskGroup and finishes in roughly the time of the slowest item.

3. Never create a task without keeping a reference.
   - The loop holds only a weak reference; a bare `asyncio.create_task(...)` can be garbage-collected mid-flight and the work silently vanishes. Hold the task, or use a TaskGroup.
   - **Done when:** every created task is owned by something.

4. Handle cancellation as a normal path.
   - `CancelledError` must propagate. Catching it broadly makes a task uncancellable and hangs shutdown. Cleanup belongs in `finally`, and must not await anything slow.
   - **Done when:** cancelling the top-level task exits promptly.

5. Bound the concurrency.
   - Ten thousand simultaneous requests will exhaust file descriptors or get the client blocked. Use a `Semaphore`.
   - **Done when:** peak concurrency is capped at a stated number.

## Verification

- Run with `PYTHONASYNCIODEBUG=1`; there are no "coroutine was never awaited" or slow-callback warnings.
- Concurrent work completes in about the time of the slowest item, not the sum.
- Interrupting the program exits cleanly rather than hanging.
