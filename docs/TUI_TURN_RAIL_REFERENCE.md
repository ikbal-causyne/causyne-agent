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
