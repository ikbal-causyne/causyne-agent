---
name: prompt-construction
description: Write or repair a prompt for a language model. Use when model output is inconsistent, when a prompt has grown by accretion, or when building any LLM-backed feature.
---

# Prompt Construction

## The shape that works

Role and task, then constraints, then the input, then the required output shape. Put the instruction BEFORE long context: attention to instructions degrades when they are buried after thousands of tokens of material.

## Workflow

1. State the task in one sentence, then the constraints as a list.
   - Prose paragraphs of mixed instruction and context are where prompts go to become unmaintainable. A list is auditable.
   - **Done when:** the task is one sentence and every constraint is a separate line.

2. Say what NOT to do, explicitly.
   - The highest-leverage lines in most prompts. "Do not invent a citation." "Do not answer if the context does not contain the answer." Negative constraints are what stop the confident wrong answer.
   - **Done when:** the failure modes you have actually observed each have a prohibition.

3. Specify the output format precisely, and validate it.
   - Ask for a named schema and parse the result. Where the provider supports structured output or tool calling, use it — that is a hard guarantee rather than a request.
   - **Done when:** the response is parsed into a validated type, and a parse failure is handled.

4. Show, do not only tell.
   - Two or three examples covering the boundary cases outperform paragraphs of description. Include a hard case and an ambiguous one; examples that are all easy teach nothing.
   - **Done when:** examples cover the cases the description leaves ambiguous.

5. Order for caching.
   - Put stable content first — system instructions, tool definitions, long reference material — and volatile content last. Providers cache a matching prefix, so this ordering is the single largest cost reduction available on a repeated prompt.
   - **Done when:** the prefix is identical across calls.

6. Change one thing at a time and measure.
   - A prompt edited by feel, several changes at once, cannot be attributed. Keep a small evaluation set.
   - **Done when:** each change has a before and after score on the evaluation set.

## Verification

- The output parses into the declared schema every time across the evaluation set.
- Each observed failure mode has a constraint addressing it.
- The stable prefix is identical between calls.
