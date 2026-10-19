---
name: terraform-state-and-modules
description: Write or review Terraform. Use when state is stored locally, when a module is copy-pasted between environments, or before a first apply against real infrastructure.
---

# Terraform State and Modules

## Invariants

1. State lives in a remote backend with locking. Local state means the first concurrent apply corrupts it and the second person destroys production.
2. `terraform plan` output is read before every apply. An apply nobody read is an outage waiting for a trigger.
3. Secrets never appear in `.tf` files or in `terraform.tfvars` committed to the repository. State itself contains secrets in plaintext — treat the backend as a secret store.

## Workflow

1. Check the backend first.
   - If `backend "local"` or no backend block exists, that is the finding to report before anything else.
   - **Done when:** the backend is remote and versioned, with locking enabled.

2. Parameterise instead of duplicating.
   - Environments differ by variable values, not by copied directories. Use one module and separate `.tfvars` or workspaces.
   - **Done when:** adding a third environment requires a new variables file and no new resource blocks.

3. Pin every provider and module version.
   - `required_providers` with `~>` constraints, and module sources with an explicit `?ref=` tag.
   - **Done when:** `terraform init` in a clean directory resolves to the same versions it did before.

4. Plan, then read the plan.
   - Count creates, updates and destroys. Any unexpected destroy stops the work and gets reported.
   - **Done when:** every line of the plan is explained, especially each destroy.

## Verification

- `terraform fmt -check` and `terraform validate` pass.
- `terraform plan` shows zero unexplained changes against the current state.
- The backend block names a remote store and locking is confirmed.
