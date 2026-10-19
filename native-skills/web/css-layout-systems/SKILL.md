---
name: css-layout-systems
description: Build a page or component layout in CSS. Use when a layout uses absolute positioning or floats, when it breaks at a viewport size, or when a container will not centre.
---

# CSS Layout Systems

## Choosing between the two

- **Flexbox** — one dimension. A row of items, a column of stacked sections, anything where content size should drive the layout.
- **Grid** — two dimensions, or any layout where the CONTAINER should define the structure regardless of content. Page shells, card grids, forms with aligned labels.

Absolute positioning is for overlays only. Floats are for wrapping text around an image and nothing else.

## Workflow

1. Name the layout in one sentence before writing CSS.
   - "A sidebar of fixed width and a main area that fills the rest" is a grid. "A row of buttons pushed to the right" is flex. The sentence picks the tool.
   - **Done when:** the layout is described in words and the tool follows from it.

2. Let the intrinsic sizing work.
   - `minmax()`, `auto-fit`, `clamp()` and `min-content` remove most media queries. A card grid that reflows with `repeat(auto-fit, minmax(16rem, 1fr))` needs no breakpoints at all.
   - **Done when:** the layout adapts across widths with as few explicit breakpoints as possible.

3. Fix overflow at the source.
   - A grid or flex item defaults to `min-width: auto`, which refuses to shrink below its content. That is why a long word or a wide table breaks the page. Set `min-width: 0` on the item.
   - **Done when:** no horizontal scrollbar appears on the page body at any width.

4. Use logical properties.
   - `margin-inline`, `padding-block`, `inset-inline-start`. They work in right-to-left languages without a second stylesheet.
   - **Done when:** the layout is correct with `dir="rtl"` set on the document.

5. Contain what scrolls.
   - Wide content — tables, code blocks, diagrams — scrolls inside its own `overflow-x: auto` container. The page body never scrolls sideways.
   - **Done when:** every wide element scrolls within itself.

## Verification

- No horizontal page scroll from 320px to 2560px.
- `dir="rtl"` produces a mirrored, correct layout.
- Zooming text to 200% does not clip or overlap content.
