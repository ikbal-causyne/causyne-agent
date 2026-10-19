---
name: infrastructure-as-code
description: Manage cloud infrastructure through code. Use when resources were created by hand, when environments have drifted, or when setting up a new environment.
---

# Infrastructure as Code

## The rule

If it was created by hand, it does not exist reproducibly. A console change is invisible, unreviewable, and gone when the account is recreated. Every persistent resource is defined in code.

## Workflow

1. Import what already exists before writing anything new.
   - Most environments have hand-made resources. Import them into state so the code describes reality; writing new code alongside undocumented resources creates conflicts and duplicates.
   - **Done when:** a plan against the existing environment shows no changes.

2. Make the environment a parameter.
   - One module, several variable files. Copied directories per environment drift within weeks, and the drift is discovered during an incident.
   - **Done when:** adding an environment requires only a new variables file.

3. Separate state by blast radius.
   - Networking, data stores and applications in separate states. One state file for everything means a mistake in the application layer can plan a change to the database.
   - **Done when:** an application change cannot plan a change to a data store.

4. Review the plan as code review.
   - The plan output goes on the pull request. Reviewing the source without the plan misses what the provider will actually do — particularly the resources it intends to replace.
   - **Done when:** every change is reviewed with its plan attached.

5. Guard destructive changes.
   - Deletion protection on data stores, and a lifecycle rule preventing accidental destruction. A resource replacement that recreates a database is the classic catastrophic apply.
   - **Done when:** no plan can destroy a data store without an explicit override.

6. Detect drift on a schedule.
   - A periodic plan that reports differences. Someone will change something in the console; the question is whether you find out in a day or during an incident.
   - **Done when:** a scheduled drift check reports differences to an owner.

## Verification

- A plan against production shows no unexplained changes.
- A new environment can be created from code alone.
- Data stores are protected from accidental destruction.
- Drift detection runs on a schedule.
