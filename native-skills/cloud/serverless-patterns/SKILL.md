---
name: serverless-patterns
description: Build or fix serverless functions. Use when cold starts are slow, when a function times out, or when a function exhausts a downstream resource.
---

# Serverless Patterns

## What is different

The execution environment is created and destroyed outside your control, may be reused, and may run thousands of copies at once. Every problem specific to serverless comes from one of those three.

## Workflow

1. Move initialisation outside the handler.
   - Code outside the handler runs once per environment and is reused across invocations. Clients, configuration and connection setup belong there. Inside the handler it runs on every single invocation.
   - **Done when:** no client is constructed inside the handler.

2. Never rely on local state persisting, and never assume it will not.
   - A warm environment retains its filesystem and memory. Writing a temporary file and not cleaning it up will eventually fill the space; caching in memory works but must tolerate a cold start.
   - **Done when:** the function is correct whether or not the environment is reused.

3. Bound the concurrency to protect what is downstream.
   - A thousand concurrent functions each opening a database connection will exhaust the database. Set a reserved concurrency limit, and use a connection proxy or a data API rather than direct connections.
   - **Done when:** peak concurrency cannot exceed what downstream can serve.

4. Make every handler idempotent.
   - Event sources deliver at least once. A retry after a timeout means the work may already have happened.
   - **Done when:** processing the same event twice produces one effect.

5. Set timeouts deliberately, on both ends.
   - The function timeout must exceed the sum of its outbound call timeouts, and each outbound call must have one. Otherwise the function times out with no useful log.
   - **Done when:** every outbound call has a timeout shorter than the function's.

6. Handle failure explicitly.
   - A dead-letter target for every asynchronous invocation, and an alert on its depth. Without one, failures vanish.
   - **Done when:** failed invocations land somewhere with an alert.

7. Address cold starts only if measured.
   - Smaller packages, a faster runtime, and provisioned concurrency where the latency genuinely matters. Provisioned concurrency costs money continuously — measure first.
   - **Done when:** cold start latency is measured and the mitigation is justified.

## Verification

- Clients are created once per environment, not per invocation.
- A load test does not exhaust downstream connections.
- The same event delivered twice produces one effect.
- Failed asynchronous invocations reach a dead-letter target.
