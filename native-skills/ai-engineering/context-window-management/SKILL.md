---
name: context-window-management
description: Handle long conversations or large inputs with a language model. Use when context is exhausted, when cost is high, or when a model forgets earlier instructions.
---

# Context Window Management

## The two costs

Tokens cost money, and attention is finite. A model given a hundred thousand tokens attends unevenly across them — material in the middle is reliably weakest. Filling the window is not the same as using it.

## Workflow

1. Measure where the tokens go.
   - System prompt, tool definitions, retrieved context, conversation history, current input. One of these is usually dominant and unexamined — tool definitions in particular grow silently.
   - **Done when:** the token budget is broken down by section.

2. Order for attention and for caching at once.
   - Stable content first (system, tools, reference material), volatile last (recent turns, current question). This maximises the cacheable prefix AND puts the question at the end, where recall is strongest.
   - **Done when:** the prefix is byte-identical across calls and the question is last.

3. Compact history rather than truncating it.
   - Dropping the oldest messages loses the original intent, which is usually the most important thing in the conversation. Keep the first message, summarise the middle, keep recent turns verbatim.
   - **Done when:** the original task survives any amount of compaction.

4. Spill large tool outputs instead of inlining them.
   - Store the full output, put a summary and a reference in the context, and let the model request more. A single large file read should not consume a third of the window.
   - **Done when:** no single tool result dominates the context.

5. Retrieve rather than include.
   - Do not put a whole document in the prompt when a retrieval step can select the relevant part. This is cheaper and usually more accurate, because it removes distractors.
   - **Done when:** included material is selected rather than wholesale.

6. Handle the limit before you hit it.
   - Detect approaching the ceiling and compact proactively. An overflow error mid-task loses the work.
   - **Done when:** the system compacts before overflow rather than failing.

## Verification

- The token budget is reported by section.
- Cache hit rate is measured on repeated calls.
- A long conversation retains the original instruction after compaction.
- Approaching the limit triggers compaction, not an error.
