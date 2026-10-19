---
name: api-client-resilience
description: Write client-side code that calls an API. Use when fetch calls have no error handling, no timeout, or no cancellation, or when a component fetches in an effect without cleanup.
---

# API Client Resilience

## What every network call needs

A timeout, a cancellation path, an error branch, and a decision about retrying. A `fetch` with none of them will eventually hang a UI on a flaky network, and that failure is invisible in testing on a fast connection.

## Workflow

1. Give every request a timeout.
   - `fetch` has no default timeout — a request can hang indefinitely. Use `AbortSignal.timeout(ms)`, and combine it with a cancellation signal via `AbortSignal.any()`.
   - **Done when:** no request can outlive a stated deadline.

2. Cancel on unmount and on supersession.
   - A request whose component has unmounted must be aborted, or it resolves into a dead component. A search-as-you-type must abort the previous request, or responses arrive out of order and the UI shows the wrong result.
   - **Done when:** rapid input produces one final result matching the last query.

3. Treat a non-2xx response as an error explicitly.
   - `fetch` does not reject on 404 or 500. Check `response.ok` — code that omits this parses an error page as data.
   - **Done when:** every call checks `response.ok` before parsing.

4. Retry only what is safe.
   - Idempotent requests (GET, PUT, DELETE) may retry with exponential backoff and jitter. A POST may not, unless it carries an idempotency key.
   - Never retry a 4xx: the request was wrong and will be wrong again.
   - **Done when:** the retry policy is stated per method, and 4xx is excluded.

5. Prefer a server-cache library over hand-rolled effects.
   - TanStack Query or SWR already implement deduplication, caching, revalidation, retry and cancellation correctly. Hand-rolling them in `useEffect` reimplements the same four bugs each time.
   - **Done when:** either a cache library is used, or the four behaviours above are each implemented and tested.

## Verification

- A request against an unreachable host fails within the timeout rather than hanging.
- Typing quickly into a search box leaves the result matching the final query.
- A 500 response surfaces as an error state, not as parsed data.
