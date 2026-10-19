---
name: webhook-delivery-and-receipt
description: Send or receive webhooks. Use when integrating a third-party callback, when webhook handlers time out, or when duplicate deliveries cause duplicate effects.
---

# Webhook Delivery and Receipt

## Receiving

1. **Verify the signature before parsing.**
   - Compute the expected signature over the RAW body and compare in constant time. Parsing first means acting on unverified input, and many frameworks mutate the body during parsing so the signature can no longer be checked at all.
   - **Done when:** an unsigned or wrongly signed request is rejected with 401 before any parsing.

2. **Check the timestamp.**
   - Reject anything older than a few minutes. Without this, a captured request can be replayed indefinitely.
   - **Done when:** a replayed old request is rejected.

3. **Acknowledge fast, process later.**
   - Persist the event and return 200 within a couple of seconds; do the work in a job. Senders time out quickly and retry, and a slow handler turns one event into many.
   - **Done when:** the handler returns before doing any real work.

4. **Deduplicate on the event id.**
   - Delivery is at-least-once from every provider. Store the id with a uniqueness constraint and ignore repeats.
   - **Done when:** delivering the same event twice produces one effect.

5. **Return the right status.**
   - 200 for accepted, including for a duplicate. 4xx only for something a retry cannot fix — a 4xx usually makes the sender stop permanently. 5xx to ask for a retry.
   - **Done when:** the status semantics are documented per branch.

## Sending

1. **Sign every request** over the raw body with a shared secret and include a timestamp.
2. **Retry with exponential backoff and jitter**, for hours, then dead-letter and notify.
3. **Give each event a stable id** so the receiver can deduplicate.
4. **Time out fast** — a few seconds — so one slow receiver cannot block the queue.
   - **Done when:** a receiver that never responds does not degrade delivery to others.

## Verification

- An unsigned request is rejected.
- The same event delivered twice produces one effect.
- The handler responds in under two seconds under load.
- A failing receiver ends up in the dead-letter queue with an alert.
