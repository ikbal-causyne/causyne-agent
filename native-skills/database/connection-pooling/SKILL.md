---
name: connection-pooling
description: Configure database connections for a service. Use when the database refuses connections, when latency spikes under load, or when a serverless function exhausts connections.
---

# Connection Pooling

## The counterintuitive part

A bigger pool is usually slower. A database has a finite number of cores and disks; connections beyond that queue INSIDE the database, where you cannot see them, instead of in your pool where you can. A pool of ten often outperforms a pool of a hundred on the same hardware.

## Workflow

1. Size from the database, not from the traffic.
   - A reasonable starting point is a small multiple of the database's core count, divided across all application instances. Then measure.
   - **Done when:** the total connections across every instance is below the database's limit with headroom.

2. Count every consumer.
   - Application instances, background workers, migration jobs, admin tools, and monitoring. The limit is shared, and the job that fails to connect is usually the one that runs during a traffic peak.
   - **Done when:** the sum of all configured pools plus reserved superuser slots fits the limit.

3. Set every timeout.
   - Connection acquisition, socket, and statement timeouts. A missing statement timeout lets one runaway query hold a connection indefinitely, and the pool drains one connection at a time until the service is down.
   - **Done when:** no query can run unbounded.

4. Add an external pooler for serverless or high instance counts.
   - Each function invocation opening its own connection exhausts the database immediately. A transaction-mode pooler in front is the standard answer — with the caveat that it breaks session-level features like prepared statements and advisory locks.
   - **Done when:** the pooling mode is chosen and its limitations are accounted for in the code.

5. Return connections deterministically.
   - Acquire and release in a `finally` or an equivalent scope guard. A leaked connection on an error path drains the pool slowly and the symptom appears hours later.
   - **Done when:** every acquisition has a guaranteed release.

6. Instrument the pool.
   - Active, idle, and waiting counts. A rising wait count is the earliest signal of saturation, well before latency shows it.
   - **Done when:** pool saturation is visible on a dashboard.

## Verification

- A load test shows stable latency with no connection errors.
- Total configured connections are within the database limit.
- A deliberately slow query is terminated by the statement timeout.
