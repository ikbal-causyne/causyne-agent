---
name: creative-studio-pipeline
description: Orchestrate end-to-end multi-stage creative production pipelines coordinating 3D modeling and rendering in Blender, Photo Studio grading and graphic compositing, and Video Studio sequence assembly. Use when a task spans multiple creative domains or requires chaining 3D outputs into video edits.
---

# Creative Studio Pipeline Orchestration

Multi-stage creative production is most reliable when coordinated through a single declarative pipeline. Rather than switching manual applications or invoking separate tools out of sequence, Causyne Agent provides `creative_apps` with `action: "studio_pipeline"`.

## Workflow

1. Design the production stages.
   - Stage A (3D Scene / Asset Generation): Blender batch (`3d_batch`) creates geometry, assigns PBR materials, positions lights/camera, and renders high-resolution stills or asset elements.
   - Stage B (Still Grading / Composition): Photo Studio batch (`studio_batch`, host `photo-studio`) adjusts color grading, adds typographic overlays or branding, and exports optimized graphic assets.
   - Stage C (Timeline Editing): Video Studio batch (`studio_batch`, host `video-studio`) constructs the sequence timeline, imports rendered stills/clips, cuts intervals, and saves the final project.
   - **Done when:** stages are mapped in dependency order.

2. Verify workspace asset directories.
   - Create organized asset folders inside workspace (e.g. `assets/renders/`, `assets/graphics/`, `projects/`).
   - Ensure all intermediate file paths point to future outputs that prior stages produce.
   - **Done when:** directory structure is prepared.

3. Configure pipeline stages.
   - Stage configuration uses an array of `{ id, type, config }`.
   - `id`: Unique identifier for logging and failure isolation (e.g., `stage_render_hero`, `stage_composite_badge`, `stage_assemble_timeline`).
   - `type`: `"3d_batch"` for Blender operations, `"studio_batch"` for Photo/Video/Motion Studio operations.
   - `config`: Complete batch payload conforming to respective engine requirements.
   - **Done when:** stage definitions are fully structured.

4. Run the coordinated pipeline.
   - Invoke `creative_apps` with `action: "studio_pipeline"` and `stages`.
   - The runtime executes stages sequentially.
   - If any stage encounters an issue, execution halts immediately with full diagnostic reporting, leaving prior outputs intact for inspection.
   - **Done when:** all stages return success.

5. Inspect artifacts.
   - Confirm generation of all planned project artifacts (.blend, .png/.psd, .prproj).
   - Verify file sizes are greater than zero.
   - **Done when:** all artifacts are present and verified.

## Failure Modes Worth Naming

- **Stage output collision:** Each stage must specify an uncreated file path; existing filenames cause immediate refusal.
- **Missing intermediate files:** Stage N must only reference outputs created in Stage N-1 or earlier.
- **Host unavailable:** If a host required by a stage is missing, check environment via `action: "status"` beforehand.

## Verification

- `action: "studio_pipeline"` completes with `success: true`.
- `stagesCompleted` equals total stages count.
- Every intermediate and final asset exists on disk in the workspace.
- Diagnostic logs demonstrate clean execution across each host engine.
