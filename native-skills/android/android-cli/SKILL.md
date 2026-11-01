---
name: android-cli
description: Use the official Google Android CLI to inspect layouts, capture screens, manage emulators, install APKs, and query Android documentation. Use when debugging app UI or controlling devices.
---

# Android CLI Specialist

Use the official Google `android` command-line tool for device interaction, UI layout inspection, screenshot capture, emulator control, and rapid delta APK installations.

## Workflow

1. Verify environment and device connectivity.
   - Run `android info` to verify Android SDK location, detected tools, and attached physical or virtual devices.
   - If `android` is not present, ensure `~/.local/bin` and `$ANDROID_HOME/platform-tools` are loaded in `PATH`.
   - **Done when:** `android info` returns valid SDK paths and lists connected devices or running emulators.

2. Inspect UI layouts and element hierarchies.
   - Run `android layout` to dump a structured JSON representation of all on-screen UI elements (resource IDs, bounds, accessibility labels, and interaction flags).
   - Use `android layout --diff` after triggering an action to output only the UI elements that changed since the last inspection, keeping context compact.
   - If an element is marked `"off-screen": true`, perform scrolling before attempting interactions.
   - **Done when:** target UI components and their coordinate bounds are parsed from the layout output.

3. Capture and resolve visual coordinates from screen captures.
   - Run `android screen capture -o /tmp/screen.png` to inspect complex Canvas or WebView screens visually.
   - Run `android screen capture --annotate -o /tmp/annotated.png` and `android screen resolve --screen /tmp/annotated.png --string "#N"` to convert visual numeric labels into exact center `(X, Y)` tap coordinates.
   - **Done when:** visual inspection confirms screen state and element centers are converted to tap coordinates.

4. Install and execute APK packages with delta acceleration.
   - Run `android run --apks=<path-to-apk> --activity=<MainActivity>` to build, deploy, and launch an app with fast delta-install.
   - When managing multiple devices, pass `--device=<serial>` explicitly to avoid multi-device targeting collisions.
   - **Done when:** the APK is installed and the activity is launched in the foreground.

5. Query official Android documentation and developer guidance.
   - Run `android docs <query>` to retrieve authoritative guidance, API references, and sample patterns directly from Google's Android Knowledge Base.
   - **Done when:** authoritative documentation confirms API usage and migration constraints.

## Verification

- `android layout` returns the expected Activity layout hierarchy and element bounds.
- UI tap or input events correctly navigate the application to the target state.
- Screen capture visually confirms the application is rendered properly without crash dialogs.
