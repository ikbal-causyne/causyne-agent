---
name: tool-calling-agents
description: Build an agent that calls tools. Use when adding function calling, when an agent loops without progressing, or when tool results are mishandled.
---

# Tool-Calling Agents

## The loop

Model proposes a call → the system validates and executes it → the result returns to the model → repeat until done. Every failure in an agent is in one of those four steps, and the validation step is the one most often skipped.

## Workflow

1. Describe tools for the model, not for a developer.
   - The description is the model's only documentation. Say when to use it AND when not to. A parameter schema with descriptions and examples per field prevents most malformed calls.
   - **Done when:** each tool says both when to use it and when not to.

2. Validate every call before executing.
   - The arguments are model output — untrusted. Parse into a schema, check ranges, and check authorization for the CALLER, not for the agent. An agent running with broad privilege on behalf of a limited user is a privilege escalation.
   - **Done when:** every call is schema-validated and authorized as the user.

3. Return errors as information, not as exceptions.
   - A failed call should return a message the model can act on: what was wrong and what to try instead. Throwing ends the loop; a good error lets it recover, which is most of the value of the agent.
   - **Done when:** every failure returns an actionable message.

4. Bound the loop from three directions.
   - Maximum steps, maximum wall time, and maximum spend. Also detect repetition: the same call with the same arguments twice means the agent is stuck, and no further iteration will help.
   - **Done when:** all three bounds exist and repetition is detected.

5. Keep the context from growing without limit.
   - Tool results accumulate quickly. Summarise or drop old results, but never drop the original instruction. Truncate large outputs and offer a way to read more.
   - **Done when:** a long run stays within the context window without losing the task.

6. Require approval for irreversible actions.
   - Deleting, sending, paying, deploying. The human sees what will happen before it happens, and dismissing the question means no.
   - **Done when:** every irreversible tool requires explicit confirmation.

## Verification

- A malformed call is rejected with a message the model can act on.
- A deliberately looping task terminates on the step or time bound.
- An irreversible action cannot execute without confirmation.
- A tool call cannot exceed the calling user's own permissions.
