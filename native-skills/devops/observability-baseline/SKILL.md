---
name: observability-baseline
description: Add logging, metrics, or tracing to a service. Use when an incident could not be diagnosed from what the service already emits, or when logs are unstructured strings.
---

# Observability Baseline

## The three questions

Instrumentation exists to answer: is it up, is it slow, and what broke. Anything that answers none of those is noise with a retention cost.

## Workflow

1. Structure the logs.
   - One JSON object per line, with a level, a timestamp, a message, and a request or trace identifier. Never interpolate values into a prose sentence — that makes them unsearchable.
   - **Done when:** every log line parses as JSON and carries a correlation identifier.

2. Emit the four signals that matter for a request-serving service.
   - Request rate, error rate, duration distribution, and saturation (queue depth, pool usage, memory).
   - Use histograms for duration, never averages. An average hides the tail, and the tail is the user experience.
   - **Done when:** a dashboard can show p50, p95 and p99 latency.

3. Propagate a trace identifier across every boundary.
   - Generate at the edge, accept from an incoming header, attach to every outbound call and every log line.
   - **Done when:** one identifier follows a request through every service it touches.

4. Redact before emitting.
   - Tokens, passwords, keys and personal data must be masked at the logging boundary, not filtered downstream.
   - **Done when:** a deliberate log of a credential-shaped value comes out masked.

5. Alert on symptoms, not causes.
   - Alert on error rate and latency, which users feel. Do not alert on CPU, which they do not.
   - **Done when:** every alert would have woken someone for a real user-visible problem.

## Verification

- Trigger an error and follow it from the log line to the trace to the metric.
- Confirm no alert fires during a normal deploy.
