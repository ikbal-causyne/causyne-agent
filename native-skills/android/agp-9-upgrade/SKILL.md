---
name: agp-9-upgrade
description: Upgrade and configure Android Gradle Plugin 9.x and modern build toolchains. Use when modernizing build scripts, fixing deprecated AGP APIs, or updating Java/Kotlin compatibility.
---

# Android Gradle Plugin Modernization

Migrate Android builds to modern Android Gradle Plugin (AGP) standards, Kotlin DSL, Java 17/21 toolchains, and Declarative Gradle configurations.

## Workflow

1. Update AGP and Gradle wrapper versions.
   - Run `./gradlew wrapper --gradle-version=<target> --distribution-type=bin` to align Gradle with the required AGP compatibility matrix.
   - Update `com.android.application` and `com.android.library` plugin versions in `gradle/libs.versions.toml`.
   - **Done when:** `./gradlew --version` reports the target Gradle and JVM versions.

2. Migrate build scripts to Kotlin DSL and modern DSL blocks.
   - Replace deprecated `compileSdkVersion` with `compileSdk = <version>`.
   - Replace deprecated `targetSdkVersion` with `targetSdk = <version>`.
   - Configure JVM toolchain: `kotlin { jvmToolchain(17) }` or `java { toolchain { languageVersion = JavaLanguageVersion.of(17) } }`.
   - **Done when:** module `build.gradle.kts` files use modern AGP DSL syntax with zero deprecation warnings.

3. Adapt to AGP Artifact and Variant API changes.
   - Replace legacy `applicationVariants.all` mutations with modern `androidComponents { onVariants { ... } }` hooks.
   - Use artifact transformations and `ScopedArtifacts` when injecting bytecode or inspecting compiled classes.
   - **Done when:** custom Gradle tasks hook into AGP build phases through modern variant APIs.

4. Verify build performance and cache compatibility.
   - Enable configuration cache in `gradle.properties`: `org.gradle.configuration-cache=true`.
   - Run `./gradlew assembleDebug --configuration-cache` to ensure all custom tasks declare inputs and outputs properly.
   - **Done when:** consecutive builds report configuration cache re-used with sub-second initialization.

## Verification

- Clean build executes and succeeds with `./gradlew assembleDebug`.
- Configuration cache stores and reloads cache entries on incremental builds.
- App installs and launches on connected emulators with modern runtime compatibility.
