---
name: photo-studio-automation
description: Automate photo editing, graphic composition, text typography, and image format exports using native Photo Studio automation. Use when a task requires batch image edits, graphic layout creation, resizing, color adjustment, or PSD/PNG/JPG/WEBP asset generation.
---

# Photo Studio Automation

Direct script execution beats screenshot clicking every time: it is exact, sub-second, costs zero vision tokens, and never misclicks because a window moved. Use the native Creative Studio bridge via `creative_apps` with `action: "studio_edit"` and `host: "photo-studio"`.

## Workflow

1. Verify environment and inspect installed creative hosts.
   - Run `creative_apps` with `action: "status"`.
   - Confirm Photo Studio availability before assembling jobs.
   - **Done when:** host availability is confirmed.

2. Establish workspace paths.
   - All inputs and outputs must reside strictly within the active workspace.
   - The output file must not already exist (the runtime enforces collision prevention).
   - Supported output extensions: `.psd`, `.png`, `.jpg`, `.jpeg`, `.webp`.
   - **Done when:** source asset and clean target output paths are defined.

3. Plan layer hierarchy and typography before applying edits.
   - If starting from scratch, omit `input` to let the engine create a canvas (1920x1080 standard).
   - If transforming existing art, provide `input` path.
   - Layer modifications should specify explicit `name`, `opacity`, `visible`, and `blendMode`.
   - Typography actions should define `text`, `x`, `y`, `size`, and font family.
   - **Done when:** sequence of edit actions is organized logically from background to foreground.

4. Apply color adjustments and canvas sizing.
   - Use `resize` or `crop` early in the action pipeline to establish composition geometry.
   - Use `adjust_color` with `brightness` (-100..100) and `contrast` (-100..100) on target layers for grading.
   - If delivering flat web assets (e.g., PNG or WEBP), include `flatten` at the end of the action chain.
   - **Done when:** geometric and tonal parameters match design requirements.

5. Execute batch and verify output.
   - Invoke `creative_apps` with `action: "studio_edit"`, `host: "photo-studio"`, `output`, and `actions`.
   - The runtime verifies execution receipt and confirms nonempty file generation.
   - **Done when:** output file exists, has nonzero byte count, and matches requested specifications.

## Failure Modes Worth Naming

- **Overwriting existing file:** The engine halts if output exists. Specify a distinct or versioned filename.
- **Outside workspace:** All paths must resolve inside the workspace root. Do not reference temporary directories or home root.
- **Missing host:** If the host is not installed, the tool gracefully reports installation status. Propose alternative image processing or check system paths.
- **Out-of-range layer index:** Layer indices start at 0. Ensure index matches existing layer count.

## Verification

- `action: "studio_edit"` returns `success: true`.
- Output file exists on disk within workspace.
- File size is non-zero.
- Format matches target extension (.psd, .png, .jpg, or .webp).
