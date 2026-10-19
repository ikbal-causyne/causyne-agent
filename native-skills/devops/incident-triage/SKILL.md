---
name: incident-triage
description: Respond to a production incident or a failing deployment. Use when a service is down, error rates have spiked, or a release must be assessed under time pressure.
---

# Incident Triage

## Order of operations

Stop the bleeding, then find the cause. Diagnosis while users are down is the most common way an incident doubles in length.

## Workflow

1. Establish the blast radius before touching anything.
   - What is failing, for whom, since when, and what changed in that window. The last question resolves most incidents on its own.
   - **Done when:** you can state the start time and the last change before it.

2. Mitigate with the fastest reversible action.
   - Roll back, disable the feature flag, or shift traffic. Do not fix forward under pressure — a hurried fix is a second incident.
   - **Done when:** the user-visible symptom is gone, whether or not the cause is known.

3. Preserve the evidence.
   - Capture logs, metrics windows and a heap or thread dump before restarting anything. A restart usually destroys the only copy of the state that explains the failure.
   - **Done when:** the evidence is saved somewhere that survives the restart.

4. Confirm recovery against a signal, not a feeling.
   - Watch the same error-rate and latency series that showed the problem, for long enough to cover a full request cycle.
   - **Done when:** the series has returned to its pre-incident band and stayed there.

5. Write the timeline while it is fresh.
   - Times, actions, and what each one changed. Blameless: the target is the system that allowed it, not the person who triggered it.
   - **Done when:** someone who was not present can follow the sequence.

## Verification

- The symptom is gone and confirmed by the original alerting signal.
- Evidence is captured.
- A follow-up action exists for the cause, separate from the mitigation.
