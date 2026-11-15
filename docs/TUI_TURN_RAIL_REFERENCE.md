# TUI turn rail: visual reference and interaction contract

Scope: `src/tui/stageSurface.js`, `src/tui/turnRail.ts`,
`src/tui/mouseHover.ts`, and corresponding TUI tests. This is separate
from the session metadata sidebar and from terminal-native scrollback.

## Source reference

The user-supplied screen recording,
`Screen Recording 2026-11-15 at 21.48.51.mov`, shows an Antigravity
conversation history navigator. Around 00:06 and 00:25 the visible behavior is:

- A **thin vertical track of dots** on the left edge of a conversation, not
  a wide metadata sidebar and not a terminal scrollbar.
- The currently inspected turn is distinguished from quieter dots.
- Hovering a dot produces a floating card showing previous conversation
  context; leaving the rail/card dismisses it.
- The composer remains anchored at the bottom and chat content remains
  visible. The UI should not require widening the terminal solely to show
  the rail.

This is a behavior and geometry reference, **not** a license to copy all
the reference application's interface or a claim of pixel-perfect parity.

## Frame-by-frame evidence from the actual 38.85-second recording

This revision is based on direct inspection of the original attached
`Screen Recording 2026-11-15 at 21.48.51.mov` (2118 × 2520 pixels at
60 fps), not the earlier single-card assumption.

- **00:05–00:06:** A dot opens a floating history panel with the time
  range **Sat, Nov 14, 3:32 AM – 8:19 PM**, **8 turns**, timestamped
  entries and a conversational title. The panel has multiple entries,
  not merely the selected turn's assistant summary.
- **00:07–00:10:** Moving to other dots changes the panel to different
  groups (including **7 turns** and **23 turns**). Each group maintains
  chronological items with short previews.
- **00:10–00:12:** Another dot opens a small **2-turn** group, while
  another opens a larger **17-turn** group. Popover height adapts to the
  number of visible entries; it is not always a fixed card height.
- **00:18–00:20:** A single latest-turn tooltip appears, containing
  the user's request and a position indicator (**239 of 239**).
- **00:26–00:29:** The cursor moves inside a multi-entry history panel;
  shortly afterward the conversation scrolls to a different portion
  and the panel disappears. Treat individual entry selection and
  transcript navigation as distinct from simply highlighting a dot.

### Behavioral invariants

- A dot represents **one turn when sparse, or a group of turns when
  dense**. Dense sampling must remain visually quiet (retain the
  existing density test), but every turn must belong to a reachable
  visible group.
- A grouped popover has a title, a time-range/turn-count header, and
  timestamped selectable user turns. The popup is an overlay:
  **do not expand/reflow underlying transcript or composer rows**.
- Clicking an entry navigates to *that entry's* message, not always
  the representative dot's earliest turn.
- When the group exceeds available preview height, wheel input inside
  the card pages the list and **must not scroll the chat behind it**.
  Wheel outside the card continues to scroll the chat.
- The real card hitbox must win over the nearby widened rail hitbox;
  synthetic/fallback preview estimates must not steal dot clicks.
- Read-only rail exploration remains available during live agent work;
  an agent's busy state is not a reason to disable the feature.
- Respect keyboard navigation, mouse opt-outs, and terminal capability
  limitations documented in `TUI_MOUSE_SCROLL_CONTRACT.md`.

### Regression tests

- `tests/tuiTurnTimelineVideoParity.test.ts`: density, group
  coverage, timestamped preview, clickable group entries, actual
  Stage overlay and nearest-visible-dot behavior.
- `tests/tuiTurnTimelineWheel.test.ts`: scrolling a 23-turn group
  without scrolling the underlying transcript and overlap hitboxes.
- `tests/interfaceIntegration.test.js`: sparse density remains
  bounded; no solid rail.
- `tests/turnRail.test.ts`: existing click/hover semantics remain
  available, including while an agent is busy.

## Causyne contract

1. A visible session with user turns and enough width paints its thin left
   turn rail without clipping the chat's message rows. Preserve a 1-column
   right scroll rail where appropriate.
2. A muted dot represents an earlier user turn; active and hovered turns
   use distinct emphasis. Dense histories may sample quieter dots, but
   active/hovered turns remain discoverable.
3. Entering a dot via mouse motion updates the hover card; clicking a dot
   navigates to that user's frame. Do not modify messages or create sessions.
4. The hover card stays inside the viewport and does not affect row height,
   scroll position, or composer layout. Keep pointer movement between the
   rail and card continuous, avoiding flicker.
5. **Rail hover uses motion tracking `?1003`**. Default to this only when
   an interactive rail with turns is shown. `CAUSYNE_MOUSE_HOVER=0`
   disables motion hover; `CAUSYNE_MOUSE_HOVER=1` explicitly enables it
   for the interactive stage. `CAUSYNE_MOUSE=0` disables all tracking.
6. When a rail disappears (narrow terminal, modal, Home, session switch or
   teardown), remove `?1003`. In a still-active chat, re-enable `?1000`
   wheel reporting, because terminal mouse tracking modes may be mutually
   exclusive. **Never trade viewport scrolling for rail hover.**
7. Stop any remaining motion mode on suspend, exit and `releaseMouse()`.
   Do not leave the terminal receiving unexpected mouse reports after exit.
8. Mouse tracking may alter native text selection; document the
   `CAUSYNE_MOUSE_HOVER=0` escape hatch. Keyboard viewport navigation
   and click-to-jump remain available when motion hover is disabled.

## Verification

- `tests/tuiTurnRailMouseLifecycle.test.ts`: hover activation, rail
  breakpoint, restoring wheel capture, Home/modal transitions, opt-out.
- `tests/turnRail.test.ts` and `tests/tuiTurnRailAlignment.test.ts`:
  turn extraction, dot placement, mouse hit targets, card bounds and rail
  column preservation.
- `tests/mouseScrollIsolation.test.ts`: wheel overscroll must stay in
  the chat viewport, even after rail transitions.
- `tests/tuiScrollModeStdout.test.ts`: mouse mode write-through under
  the console guard and complete shutdown cleanup.

For real-terminal validation, test macOS Terminal.app with
`View > Allow Mouse Reporting` enabled, and another modern terminal,
including pointer hover, wheel scroll, a modal open/close cycle, a terminal
resize from 170 to 60 columns, and exit back to the shell.

If a host refuses to forward motion events, fall back to clickable dots
and keyboard scroll. Do not claim a renderer fix for missing terminal
input events. See `docs/TUI_MOUSE_SCROLL_CONTRACT.md`.
