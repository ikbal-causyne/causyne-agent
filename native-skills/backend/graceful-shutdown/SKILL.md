---
name: graceful-shutdown
description: Make a service shut down cleanly. Use when a restart drops requests, when jobs are lost on deploy, or when a container takes the full termination grace period to exit.
---

# Graceful Shutdown

## The sequence

Stop accepting new work → finish work in flight → release resources → exit. A process that exits on the signal drops every live request, and under a rolling deploy that is a burst of user-visible errors on every release.

## Workflow

1. Handle the termination signal, and the interrupt too.
   - The orchestrator sends the termination signal and then waits a grace period before killing. Handle both signals; a container ignoring the signal always takes the full grace period.
   - **Done when:** the process exits on signal in well under the grace period.

2. Fail readiness before you stop listening.
   - Mark the instance unready first, then wait for the load balancer to notice — typically a few seconds — and only then stop accepting connections. Closing the listener immediately means the balancer is still routing to a closed socket.
   - **Done when:** there is a deliberate delay between failing readiness and closing the listener.

3. Drain in-flight work with a deadline.
   - Wait for open requests to finish, but not forever. A deadline shorter than the orchestrator's grace period, then force the close.
   - **Done when:** shutdown completes within the deadline whether or not work finished.

4. Stop background workers cleanly.
   - Stop pulling new jobs, let the current one finish or return it to the queue. A job abandoned mid-flight must be re-runnable — which is why job handlers are idempotent.
   - **Done when:** no job is lost or half-applied when a worker stops.

5. Release resources in reverse order of acquisition.
   - Close the server, then the queue consumers, then the database pool. Closing the pool first fails the requests still draining.
   - **Done when:** shutdown logs show the reverse order and no error.

6. Never exit non-zero on a clean shutdown.
   - The orchestrator reads a non-zero exit as a crash and may back off the whole deploy.
   - **Done when:** a signalled shutdown exits 0.

## Verification

- A rolling restart under load produces zero failed requests.
- The process exits well inside the grace period.
- Stopping a worker mid-job leaves the job re-runnable.
