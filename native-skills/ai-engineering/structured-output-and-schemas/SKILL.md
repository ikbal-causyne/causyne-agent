---
name: structured-output-and-schemas
description: Get reliable structured data out of a language model. Use when parsing model output fails, when JSON is malformed, or when output must feed another system.
---

# Structured Output and Schemas

## The ordering of defences

1. Use the provider's structured output or tool-calling mode. This constrains generation and is a guarantee, not a request.
2. Where unavailable, ask for a schema and validate.
3. Repair or retry on failure.
4. Never regex your way through malformed output — that fails silently on the case you did not anticipate.

## Workflow

1. Define the schema first, in code.
   - A single definition generates both the prompt's schema description and the runtime validator. Two hand-written copies drift, and the drift shows up as an unparseable response in production.
   - **Done when:** the schema has one source and both uses derive from it.

2. Keep the schema shallow and named.
   - Deep nesting and unions raise the failure rate. Descriptive field names do real work — `total_amount_usd` produces better output than `amt`, because the name is part of the instruction.
   - **Done when:** nesting is shallow and every field name is self-explanatory.

3. Make the uncertain case representable.
   - If the model may not know a value, the schema needs a null or an explicit unknown. Without one, it will invent a plausible value — the schema forces a shape, not a truth.
   - **Done when:** every field the model might not know can express that.

4. Validate, then retry with the error.
   - On a validation failure, send the error back and ask for a correction. This recovers most failures in one extra call. Bound the retries.
   - **Done when:** a validation failure triggers a bounded repair loop.

5. Validate semantics, not just shape.
   - A schema check confirms it is a number, not that it is the right number. Range checks, referential checks, and cross-field consistency belong after parsing.
   - **Done when:** semantic checks run after schema validation.

6. Log every failure with the raw output.
   - Failure patterns tell you what to fix in the schema or the prompt. Without the raw text there is nothing to learn from.
   - **Done when:** raw output is retained on every parse failure.

## Verification

- The evaluation set parses successfully every time.
- A deliberately impossible request produces an explicit unknown, not an invention.
- A malformed response is repaired within the retry bound or fails cleanly.
