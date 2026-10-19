---
name: github-actions-ci
description: Write or repair a GitHub Actions workflow for build, test, or release. Use when a repository has no CI, when a workflow is slow, or when a job fails only in CI and not locally.
---

# GitHub Actions CI

## Workflow

1. Establish what must be true before a merge.
   - Usually: install, lint, test, build. Ask which of those already exist as scripts rather than inventing commands.
   - **Done when:** every gate maps to a command that already runs locally.

2. Pin the trigger narrowly.
   - `pull_request` plus `push` on the default branch. A workflow that runs on every push to every branch burns minutes and teaches people to ignore red.
   - **Done when:** the trigger block names specific branches or paths.

3. Cache the dependency layer.
   - `actions/setup-node` and `actions/setup-python` take a `cache` input; use it rather than hand-rolling `actions/cache`.
   - **Done when:** a second run reports a cache hit and installs in a fraction of the first run's time.

4. Make failure legible.
   - Upload test reports and build logs as artifacts on failure. A red check with no artefact costs someone a local reproduction.
   - **Done when:** a deliberately failing run leaves an artefact that explains the failure.

5. Lock down the token.
   - Set `permissions:` explicitly at the workflow level. The default grant is far wider than a test job needs.
   - **Done when:** `permissions` names only what the job writes, typically `contents: read`.

## Template

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm test
```

## Verification

- Push a branch and confirm the workflow runs and passes.
- Confirm a second run hits the cache.
- Confirm `concurrency` cancels a superseded run rather than queueing it.
