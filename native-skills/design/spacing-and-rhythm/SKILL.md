---
name: spacing-and-rhythm
description: Set spacing and alignment in an interface. Use when padding values look arbitrary, when a layout feels cramped or loose, or when elements do not line up.
---

# Spacing and Rhythm

## The single rule

Every space is a step on one scale. The moment an arbitrary value appears — `padding: 13px` — the rhythm is broken, and the eye reads the whole layout as slightly wrong without being able to say why.

## Workflow

1. Define the scale once.
   - A geometric-ish ramp from a 4px or 8px base: 4, 8, 12, 16, 24, 32, 48, 64, 96. Name them and use only these.
   - **Done when:** no spacing value in the codebase is outside the scale.

2. Space by relationship, not by taste.
   - Elements that belong together get less space than elements that do not. This proximity grouping carries more meaning than borders or boxes ever will, and it costs no ink.
   - **Done when:** the grouping is readable from spacing alone, with all borders removed.

3. Give sections room proportional to their weight.
   - A page section needs several times the space of an element within it. Uniform spacing everywhere flattens the structure.
   - **Done when:** the top-level structure is visible when scrolling quickly.

4. Space in one direction.
   - Set margin on one side only (`margin-block-end`, or a flex/grid `gap`). Margins on both sides collapse unpredictably and make spacing impossible to reason about.
   - **Done when:** no element sets both a top and a bottom margin.

5. Align to a small number of edges.
   - Every element should line up with something. Multiple near-but-not-equal left edges is the most visible sign of an unconsidered layout.
   - **Done when:** drawing vertical lines through the layout shows few distinct alignment edges.

## Verification

- Grep the stylesheet for spacing values not on the scale — there should be none.
- With all borders and backgrounds removed, the grouping is still legible.
- Overlaying a vertical rule at each alignment edge produces a small number of lines.
