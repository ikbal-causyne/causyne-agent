---
name: type-scale-and-hierarchy
description: Set typography for an interface or document. Use when text sizes were picked ad hoc, when headings and body are hard to tell apart, or when long text is hard to read.
---

# Type Scale and Hierarchy

## What makes typography read as designed

A small number of sizes, related by a ratio, with weight and space doing the rest of the work. Interfaces look amateurish when every element gets its own size, and when hierarchy is expressed only by making things bigger.

## Workflow

1. Build a scale, do not pick sizes.
   - Choose a base (16px for body on the web) and a ratio: 1.2 for dense interfaces, 1.25 for general use, 1.333 or 1.5 for editorial with few levels.
   - Round to whole pixels and keep five to seven steps total. More than that and the steps stop being distinguishable.
   - **Done when:** every size in the design is a step on the scale.

2. Set the measure before the size.
   - 45–75 characters per line for body text. Longer and the eye loses the return; shorter and it breaks rhythm. `max-width: 65ch` is the direct expression of this.
   - **Done when:** body text sits between 45 and 75 characters per line at every breakpoint.

3. Set line height inversely to size.
   - Body 1.5–1.6. Headings 1.1–1.25. A heading at body line height looks loose and disconnected from itself.
   - **Done when:** each level has a line height appropriate to its size.

4. Express hierarchy with three tools, not one.
   - Size, weight, and colour or space. Two levels that differ only in size need a large gap to read as different; two that differ in weight and space can be one step apart.
   - **Done when:** hierarchy survives a squint test — the reading order is obvious out of focus.

5. Restrain the families.
   - One typeface with a real range of weights beats two chosen for contrast. If two, make them genuinely different in category (a serif display against a sans body), never two similar sans faces.
   - **Done when:** the design uses at most two families, with a stated reason for the second.

## Verification

- Every text size in the rendered page is a step on the declared scale.
- Body measure is within 45–75 characters at all breakpoints.
- The page passes a squint test: the reading order is clear when blurred.
