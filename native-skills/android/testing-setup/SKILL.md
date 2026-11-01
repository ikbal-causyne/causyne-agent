---
name: testing-setup
description: Configure and execute automated Android unit and instrumentation tests. Use when setting up ComposeTestRule, Espresso, Robolectric, or verifying UI journeys on an emulator.
---

# Android Automated Testing and Verification

Configure test harnesses, author Jetpack Compose UI tests, and execute local unit tests and on-device instrumentation tests through Gradle.

## Workflow

1. Configure test dependencies in Gradle version catalog.
   - Declare dependencies in `gradle/libs.versions.toml`:
     `androidx-compose-ui-test-junit4`, `androidx-compose-ui-test-manifest`, `androidx-test-ext-junit`, `androidx-test-espresso-core`, `robolectric`, and `kotlinx-coroutines-test`.
   - In `app/build.gradle.kts`, configure `testImplementation` and `androidTestImplementation`.
   - **Done when:** Gradle dependencies resolve cleanly without version conflicts.

2. Structure Jetpack Compose UI tests.
   - Use `createAndroidComposeRule<MainActivity>()` or `createComposeRule()` in `androidTest`.
   - Find elements by semantics or test tags: `composeTestRule.onNodeWithText("...").performClick()`.
   - Assert element states: `composeTestRule.onNodeWithTag("submit_button").assertIsEnabled()`.
   - **Done when:** Compose test cases exercise user interactions and assert resulting UI states.

3. Run local JVM unit tests.
   - Execute `./gradlew testDebugUnitTest` for fast headless verification.
   - Use Robolectric or mock Android framework classes when unit tests reference Android Context or resources.
   - **Done when:** `./gradlew testDebugUnitTest` finishes with `BUILD SUCCESSFUL` and 100% test pass rate.

4. Execute on-device instrumentation tests.
   - Ensure an active emulator or connected physical device is online via `adb devices`.
   - Run `./gradlew connectedDebugAndroidTest` to execute tests inside the Android runtime.
   - Inspect XML test results in `app/build/reports/androidTests/connected/`.
   - **Done when:** all connected on-device tests pass and generate green HTML/XML test reports.

## Verification

- `./gradlew testDebugUnitTest` passes with zero assertion errors.
- `./gradlew connectedDebugAndroidTest` passes on the connected emulator without timeouts.
- Test coverage reports confirm critical user journeys are validated.
