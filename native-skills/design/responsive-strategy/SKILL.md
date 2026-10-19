---
name: responsive-strategy
description: Make an interface work across screen sizes. Use when a layout breaks on mobile, when breakpoints are copied from a framework, or when a design was built for one width.
---

# Responsive Strategy

## Breakpoints come from the content

The right breakpoint is the width at which THIS layout stops working — found by resizing until it breaks. Device-named breakpoints copied from a framework describe hardware that no longer exists and produce layouts that are wrong on real screens.

## Workflow

1. Design the narrow case first.
   - A single column forces a decision about priority: what does the user need first. Widening then adds; narrowing from a wide design only ever removes, and the removal is arbitrary.
   - **Done when:** the interface is complete and usable at 320px.

2. Prefer intrinsic sizing to breakpoints.
   - `clamp()` for type and spacing, `minmax()` with `auto-fit` for grids, `flex-wrap` for rows. Each of these removes a breakpoint entirely and adapts continuously rather than in jumps.
   - **Done when:** the count of media queries is as low as the layout allows.

3. Use container queries for components.
   - A card in a sidebar and the same card in a main column should lay out differently. That depends on the CONTAINER width, not the viewport, and a media query cannot express it.
   - **Done when:** components respond to their own container.

4. Respect touch and pointer differences.
   - Touch targets at least 44px. Hover-only affordances need a tap equivalent. Test with a real finger, not a narrow browser window.
   - **Done when:** every action is reachable by touch without hovering.

5. Handle the vertical axis too.
   - Landscape phones and split-screen windows are short. A hero sized in `100vh` is unusable there. Use `100dvh` or a `min-height` with content-driven growth.
   - **Done when:** the interface works at 320×480 as well as 1920×1080.

## Verification

- No horizontal scroll from 320px to 2560px.
- Every interactive target is at least 44px on touch.
- Zooming text to 200% neither clips nor overlaps content.
- The layout is usable in a short landscape viewport.
