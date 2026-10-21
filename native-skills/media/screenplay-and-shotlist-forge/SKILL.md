---
name: screenplay-and-shotlist-forge
description: Format professional Hollywood screenplays in Courier 12pt, create director production shot lists, and build voiceover timing cue sheets with Words-Per-Minute pacing analysis. Use for movie scripts, video storytelling, documentary shotlists, and audio dubbing timelines.
---

# Screenplay & Production Shot List Forge

High-end cinematic storytelling and video production require standardized industry formatting so that directors, cinematographers, and editors can immediately execute on set and in the edit suite.

## Specifications

- **Screenplay Typography:** Courier 12pt monospaced font, exactly 6 lines per inch vertical rhythm.
- **Screenplay Margins:** Left margin 1.5 inches; right, top, and bottom margins 1.0 inch.
- **Pacing Standard:** Voiceover narration moves at 130 to 155 Words-Per-Minute for natural documentary cadence.

## Workflow

1. Format screenplay elements and layout.
   - Author scenes using `document_forge` (`action: "format_screenplay"`, `screenplaySpec`).
   - Format scene headings in uppercase, character cues indented 2.2 inches, and dialogue width constrained to 3.5 inches.
   - **Done when:** script HTML and CSS with Courier 12pt specifications are generated.

2. Build director's production shot list.
   - Generate production shot lists with `document_forge` (`action: "format_shotlist"`, `shotList`).
   - Assign camera framing (EWS, WS, MS, CU, ECU), lenses, movement, and audio cues.
   - **Done when:** structured shot list grid is compiled with cumulative duration estimates.

3. Analyze voiceover timing and narration pacing.
   - Audit narration pacing with `document_forge` (`action: "analyze_vo"`, `voBlocks`).
   - Ensure word density stays within 130 to 155 WPM for optimal documentary pacing.
   - **Done when:** pacing status is confirmed as optimal across all audio blocks.

4. Render and verify publication files.
   - Render scripts or shot lists to vector PDF via `document_forge` (`action: "render_pdf"`).
   - **Done when:** output PDF files exist and are verified visually.

## Verification

- `document_forge` returns `success: true`.
- Screenplay HTML contains Courier 12pt typography and 1.5-inch left margin.
- Shot list table summarizes total shots and total runtime.
- Voiceover analysis confirms pacing within target WPM limits.
