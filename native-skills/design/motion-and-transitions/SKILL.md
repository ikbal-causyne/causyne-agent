---
name: motion-and-transitions
description: Add animation or transitions to an interface. Use when a UI changes state abruptly, when animations feel slow, or when motion is being added for its own sake.
---

# Motion and Transitions

## What motion is for

Explaining a change. Where something came from, where it went, what is loading. Motion that explains nothing is decoration, and decoration on a screen someone uses fifty times a day becomes an irritation.

## Workflow

1. Justify each animation in one sentence.
   - "This shows the panel came from the button." If the sentence cannot be written, remove the animation.
   - **Done when:** every transition has a stated purpose.

2. Set duration by distance and size.
   - Small local changes 100–150ms. Panels and modals 200–300ms. Full-page transitions up to 400ms. Anything over 400ms feels broken, however smooth.
   - **Done when:** no interaction feedback exceeds 400ms.

3. Choose easing by direction.
   - Entering: ease-out — fast start, gentle settle. Leaving: ease-in — the element is going, so get on with it. Moving between two on-screen positions: ease-in-out. Never `linear` for anything physical.
   - **Done when:** entrances and exits use different curves.

4. Animate only compositor-friendly properties.
   - `transform` and `opacity` do not trigger layout. Animating `width`, `height`, `top` or `margin` forces layout on every frame and drops to a visible stutter on a mid-tier device.
   - **Done when:** the performance panel shows no layout recalculation during the animation.

5. Honour the reduced-motion preference.
   - `@media (prefers-reduced-motion: reduce)` must remove or shorten motion. For some people, motion causes nausea — this is an accessibility requirement, not a nicety.
   - **Done when:** with the preference set, transitions are instant or minimal and nothing breaks.

## Verification

- Every animation has a stated purpose.
- The performance panel shows no layout thrash during motion.
- With reduced motion enabled the interface is fully functional.
