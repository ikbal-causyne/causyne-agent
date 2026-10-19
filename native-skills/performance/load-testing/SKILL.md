---
name: load-testing
description: Find out how a system behaves under load. Use before a launch, before a traffic event, or after a capacity-related incident.
---

# Load Testing

## What you are looking for

Not the maximum throughput. The point at which latency degrades, and what happens beyond it. A system that quietly falls over at 2× normal traffic is the problem; the exact breaking number is secondary.

## Workflow

1. Define the scenario from real traffic.
   - Endpoint mix, think time, payload sizes and the cache-hit ratio, taken from production logs. A test hammering one endpoint with no think time measures something no user will ever do.
   - **Done when:** the scenario's mix is derived from observed traffic.

2. Test against production-like infrastructure and data.
   - Same instance sizes, same database size, same cache state. A test against an empty database measures the empty database.
   - **Done when:** the environment's differences from production are listed and their effect stated.

3. Ramp rather than spike.
   - Increase load gradually and watch where latency turns upward. That knee is the useful number. A spike test is a separate scenario for autoscaling behaviour.
   - **Done when:** the latency knee is identified.

4. Watch the system, not just the client.
   - CPU, memory, connection pool saturation, database load, queue depth, and error rate. The client only sees the symptom; the cause is inside.
   - **Done when:** the first resource to saturate is named.

5. Push past the knee deliberately.
   - Graceful degradation — shedding load, returning 429, serving stale — is a design property, not an accident. Confirm the system does something sensible rather than collapsing.
   - **Done when:** behaviour beyond capacity is characterised and acceptable.

6. Soak at a sustainable level.
   - Several hours at a realistic load finds leaks, connection exhaustion, and log-disk growth — none of which appear in a ten-minute run.
   - **Done when:** a multi-hour run shows flat memory and stable latency.

## Verification

- The latency knee and the first saturating resource are both reported.
- Behaviour beyond capacity is documented.
- A soak run shows no resource growth over time.
