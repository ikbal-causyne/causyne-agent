---
name: dependency-supply-chain
description: Add, update, or audit dependencies. Use when introducing a package, when an advisory appears, or when reviewing what a project pulls in.
---

# Dependency Supply Chain

## The exposure

A dependency runs with your process's full privileges. Its dependencies do too, and a typical project has hundreds it never chose. Most real compromises come through this path rather than through your own code.

## Workflow

1. Justify each direct dependency before adding it.
   - What does it do, how much does it weigh, how many transitive dependencies does it bring, when was it last released, how many maintainers. A one-function package with forty dependencies is a bad trade.
   - **Done when:** the addition is justified against writing it yourself.

2. Check the package is the one you mean.
   - Typosquatting relies on a plausible name. Confirm the exact name, the repository link, and the download count. A brand-new package with a familiar name is the classic attack.
   - **Done when:** the package's repository and history are confirmed.

3. Commit the lock file and install from it.
   - `npm ci`, `pip install -r` with hashes, `poetry install`, `cargo build --locked`. An install that resolves fresh versions in CI means the artefact you tested is not the artefact you shipped.
   - **Done when:** CI installs from the lock file and fails if it is out of date.

4. Refuse install scripts you have not read.
   - A lifecycle script runs arbitrary code at install time, in your CI, with your credentials. Where the ecosystem allows disabling them by default, do.
   - **Done when:** the install-time script surface is known and minimised.

5. Automate advisory scanning, and triage rather than ignore.
   - Run the ecosystem audit in CI. For each finding, decide: upgrade, replace, or accept with a written reason and an expiry. A permanently ignored advisory is a decision nobody revisits.
   - **Done when:** every open advisory has an action or a dated acceptance.

6. Pin what you cannot verify.
   - Actions and containers by digest, not by tag. A mutable tag can be repointed after review.
   - **Done when:** CI actions and base images are pinned to digests.

## Verification

- The lock file is committed and CI installs from it.
- The audit runs in CI and has no unreviewed findings.
- Every CI action is pinned by digest.
