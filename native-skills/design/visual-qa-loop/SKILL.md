---
name: visual-qa-loop
description: Check that a built interface actually looks right. Use after implementing any UI, and before declaring visual work finished.
---

# Visual QA Loop

## The rule

Look at it. A human developer opens the browser; anything building an interface must do the same. Code that compiles and tests that pass say nothing about whether the result is usable or whether it looks like a template.

## Workflow

1. Render it and capture the result.
   - Take a screenshot at a realistic width. Reading the markup is not a substitute — spacing, contrast and hierarchy are only visible when rendered.
   - **Done when:** a screenshot of the actual rendered page exists.

2. Run the squint test.
   - Blur the image mentally or literally. The reading order should be obvious, the primary action should stand out, and the grouping should be visible. If everything has equal weight, the hierarchy failed.
   - **Done when:** the intended reading order survives blurring.

3. Check against the design brief.
   - Re-read the direction that was chosen. Does the result match the named reference and avoid the three negative adjectives?
   - **Done when:** the result matches the brief, or the mismatch is named and fixed.

4. Check the states, not just the happy path.
   - Empty, loading, error, one item, and far too many items. Long names, long text, missing images. Most visual bugs live in the states nobody screenshots.
   - **Done when:** every state has been rendered and looks deliberate.

5. Check both themes and both extremes of width.
   - Light and dark, 320px and 2560px. A design checked at one width in one theme is checked at a quarter of its surface.
   - **Done when:** all four combinations are rendered and correct.

6. If it looks generic, rebuild rather than adjust.
   - A centred hero, a gradient headline, three equal cards and rounded everything is the default shape, not a design. Adjusting its padding does not fix it.
   - **Done when:** the result would not be mistaken for a template.

## Verification

- Screenshots exist for every state, both themes, and both width extremes.
- The squint test passes.
- The result traces to the design brief.
