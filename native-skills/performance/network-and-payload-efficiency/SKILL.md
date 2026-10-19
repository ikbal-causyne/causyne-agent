---
name: network-and-payload-efficiency
description: Reduce time spent on the network. Use when an app is slow on a mobile connection, when payloads are large, or when a screen makes many requests.
---

# Network and Payload Efficiency

## What dominates on a real connection

Round trips, not bandwidth. On a mobile network each round trip costs tens to hundreds of milliseconds regardless of payload size. Eliminating a request is worth far more than shrinking one.

## Workflow

1. Count the requests on the critical path.
   - Waterfall view. Look for sequential chains — a request whose response is needed to start the next. Each link is a full round trip.
   - **Done when:** the length of the longest sequential chain is known.

2. Break the chains.
   - Return what the screen needs in one response, or issue independent requests in parallel. A screen that fetches a user, then their orders, then each order's items is three round trips deep before anything renders.
   - **Done when:** no chain on the critical path is longer than two.

3. Send only what is used.
   - A response with forty fields where the screen shows four wastes serialisation, transfer and parsing. Support field selection, or provide a purpose-built endpoint.
   - **Done when:** responses contain no field the client ignores.

4. Compress and cache correctly.
   - Compression on for text responses. `Cache-Control` with a real max-age for anything stable, and `ETag` for anything revalidatable. A correct 304 costs one round trip and no body.
   - **Done when:** repeat loads are served from cache or revalidated without a body.

5. Paginate and stream large results.
   - Cursor pagination for lists, streaming for large payloads so the client can begin before the end arrives.
   - **Done when:** no endpoint returns an unbounded body.

6. Move the data closer.
   - A CDN for static assets and cacheable responses. Geography is a fixed cost that no amount of optimisation removes.
   - **Done when:** static assets are served from an edge location.

## Verification

- Requests on the critical path are counted before and after.
- Repeat loads produce 304 responses or cache hits.
- The app is tested on a throttled connection with added latency, not on the local network.
