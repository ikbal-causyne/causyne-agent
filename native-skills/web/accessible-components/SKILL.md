---
name: accessible-components
description: Build or audit an interactive UI component — modal, dropdown, tabs, menu, form. Use when a component is built from divs, when it cannot be operated by keyboard, or when accessibility is being reviewed.
---

# Accessible Components

## The first rule

Use the native element. `<button>`, `<a href>`, `<details>`, `<dialog>`, `<input type="checkbox">`. Every one of them brings focus handling, keyboard behaviour, and screen-reader semantics that a div plus ARIA has to reimplement, usually incompletely. Reach for ARIA only when no native element exists.

## Workflow

1. Audit by keyboard alone.
   - Unplug the mouse. Tab through the component. Can you reach everything, operate everything, and see where focus is?
   - **Done when:** every interactive element is reachable and operable, and the focus ring is always visible.

2. Fix semantics before appearance.
   - A clickable div needs `role`, `tabindex`, and key handlers for Enter and Space. A button needs none of them. Convert rather than patch.
   - **Done when:** the accessibility tree in DevTools shows the right role for every control.

3. Manage focus at boundaries.
   - Opening a modal moves focus into it and traps it there. Closing returns focus to the trigger. Without the return, keyboard users land at the top of the document.
   - **Done when:** opening and closing leaves focus exactly where a mouse user's attention would be.

4. Name everything.
   - Every control has an accessible name: visible text, `aria-label`, or a `<label for>`. An icon-only button with no name is unusable by a screen reader.
   - **Done when:** no control in the accessibility tree has an empty name.

5. Announce what changes.
   - Content that appears without a page change (validation errors, toasts, results counts) needs a live region, or it is silent.
   - **Done when:** a screen reader announces the change without the user hunting for it.

## Per-component keyboard contracts

- **Modal:** Escape closes, focus trapped, `role="dialog"` `aria-modal="true"`, labelled by its title.
- **Tabs:** arrow keys move between tabs, Tab moves into the panel, `aria-selected` and `aria-controls` wired.
- **Menu:** arrows move, Escape closes and returns focus, Home and End jump to the ends.
- **Combobox:** arrows move through options, Enter selects, Escape reverts, `aria-activedescendant` tracks.

## Verification

- The whole flow is completable with the keyboard only.
- `axe` or the browser's accessibility audit reports no violations.
- Every control has a non-empty accessible name.
