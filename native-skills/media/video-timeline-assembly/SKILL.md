---
name: video-timeline-assembly
description: Assemble video timelines, import media clips to sequences, place markers, make precision edits, and export project files using native Video Studio automation. Use when a task requires automated video sequence building, cutting, multicam timeline layout, or PRPROJ/XML project generation.
---

# Video Timeline Assembly

Timeline video editing is vastly faster and more dependable through direct project automation than GUI pixel clicking. Causyne Agent connects to the local Video Studio host via `creative_apps` (`action: "studio_edit"`, `host: "video-studio"`).

## Workflow

1. Check host installation.
   - Run `creative_apps` with `action: "status"`.
   - Ensure the Video Studio engine is discovered locally.
   - **Done when:** host availability is confirmed.

2. Prepare media assets in workspace.
   - Collect source video, audio, and graphic clips inside the project workspace directory.
   - Keep media paths relative to the current workspace root.
   - Output must be a new `.prproj` or `.xml` file path that does not yet exist.
   - **Done when:** all media files are present on disk and target project path is specified.

3. Establish sequence settings.
   - Begin with a `sequence` action specifying sequence `name`, `width`, `height`, and `fps`.
   - Standard 1080p: `width: 1920`, `height: 1080`, `fps: 30` (or 24).
   - Standard 4K UHD: `width: 3840`, `height: 2160`, `fps: 60` (or 30/24).
   - **Done when:** sequence resolution and frame rate are locked.

4. Import and place media clips along the timeline.
   - Use `import` actions with `path`, `start` time in seconds, and `track` index (0 for primary video).
   - Specify `duration` if clipping the source media to a specific length.
   - Place voiceover, ambient sound, or music tracks with `mediaType: "audio"`.
   - Add timeline markers with `marker` action (`start`, `name`, `comment`) for scene transitions or cue points.
   - **Done when:** all media elements are arranged sequentially without unexpected track overlaps.

5. Execute automation and inspect generated project.
   - Invoke `creative_apps` with `action: "studio_edit"`, `host: "video-studio"`, `output`, and `actions`.
   - Verify that the resulting `.prproj` or `.xml` is written cleanly.
   - **Done when:** project file exists on disk with non-zero size.

## Failure Modes Worth Naming

- **Media file missing on disk:** Every imported file path must exist before running the automation batch.
- **Output collision:** Target `.prproj` must be a fresh filename; the runtime refuses to overwrite existing project files.
- **Timeline drift:** When laying clips sequentially, track cumulative duration so clips don't unintentionally overlap on the same track unless intended.

## Verification

- `action: "studio_edit"` returns `success: true`.
- Output `.prproj` or `.xml` exists inside workspace.
- Output file size is non-zero.
- All imported media files exist and are referenced in the project structure.
