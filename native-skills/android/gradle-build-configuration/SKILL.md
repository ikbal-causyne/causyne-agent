---
name: gradle-build-configuration
description: Configure or repair an Android Gradle build. Use when a build fails after a dependency change, when build times are long, or when version numbers are scattered across files.
---

# Android Gradle Configuration

## Workflow

1. Centralise versions in the version catalog.
   - `gradle/libs.versions.toml` holds every version, library and plugin. Versions hardcoded across module build files drift, and a mismatch between two artifacts of the same library produces link errors that name neither.
   - **Done when:** no module build file contains a literal version string.

2. Keep configuration out of the execution path.
   - Reading a file or running a command at configuration time runs on every build, including `--dry-run`. Wrap it in a provider so it runs only when the task does.
   - **Done when:** the configuration phase takes under a second on a warm build.

3. Enable the correctness features deliberately.
   - Configuration cache and build cache both give large wins and both expose incorrectly declared tasks. Turn them on and fix what breaks — what breaks was already wrong.
   - **Done when:** a second build with no changes reports mostly up-to-date or cached tasks.

4. Separate build types honestly.
   - Debug: no minification, debuggable, a distinct application id suffix so it installs alongside release.
   - Release: minification and resource shrinking on, and a signing config that reads from the environment or a properties file that is not committed.
   - **Done when:** debug and release can be installed on the same device simultaneously.

5. Keep the minification rules with the code they protect.
   - Consumer rules belong in the library module that needs them, not in the app's file. A library whose rules live in the app breaks for every other consumer.
   - **Done when:** each module ships the rules its own code requires.

## Common failures

- **Duplicate class:** two dependencies bundling the same library. Resolve with a dependency constraint, never by excluding blindly.
- **Manifest merger conflict:** read the merged manifest report; add `tools:replace` only after understanding which value should win.
- **Method count:** enable multidex or, better, shrink what is actually unused.

## Verification

- A clean build succeeds and an incremental build is substantially faster.
- Release and debug variants both install and run.
- No version literal exists outside the catalog.
