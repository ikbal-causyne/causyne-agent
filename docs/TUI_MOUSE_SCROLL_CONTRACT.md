# TUI mouse-wheel scroll contract

Scope: `src/tui/keys.js`, `src/tui/stageSurface.js`,
`src/tui/scrollInteraction.ts`, `src/tui/prompt.js`, and their TUI tests.
This note documents required behavior, not a claim of universal terminal support.

## Invariant

When a live, interactive Stage owns the chat, incoming wheel reports move
`surface.viewport` only. At either limit the viewport clamps; wheel overscroll
must **not** call `releaseMouse()`, disable tracking, write terminal scrollback
commands, mutate the composer, or switch to native terminal scrolling.
The terminal scrollback remains a separate surface; it should not move as a
side effect of normal chat wheel input. A user can still use page-up/down
keyboard navigation if the host does not support mouse reporting.

## Protocol and lifecycle

- `mouseTracking(true)` enables SGR `?1006` **before** the reporting mode
  `?1000`. This prevents events being decoded in legacy X10 format during
  activation. On disable, reset `?1000` before resetting `?1006`.
- The terminal provides SGR wheel-up/down as `ESC [ <64;x;yM` and
  `ESC [ <65;x;yM`. The decoder emits `wheel` input, which
  `ChatPrompt.handleScrollKey` routes to the viewport or an intentionally
  focused scrolling overlay. No ANSI wheel bytes belong in the text editor.
- `StageSurface` arms reporting only while its session Stage owns the
  terminal. Home, exit, suspend, and exceptional teardown must turn off tracking.
  `runWithStageWrite` must wrap intentional control writes so the
  console guard does not discard them.
- `?1003` any-motion tracking is distinct from `?1000`: it is needed for
  hover previews, *not* ordinary wheel scrolling. A transition away from motion
  mode must restore `?1000` while a chat remains active.
- Respect `CAUSYNE_MOUSE=0`: do not silently bypass an explicit opt-out.
  `CAUSYNE_MOUSE_HOVER=0` disables hover tracking. Disabling mouse reports
  means the terminal may scroll its own history, by design.

## Host limitations

There is no portable way for a Node TUI to force a host terminal to forward
mouse events. **macOS Terminal.app** has a separate `View > Allow Mouse
Reporting` toggle. If unchecked, Terminal.app scrolls locally even if Causyne
writes the correct DECSET sequences. Check that setting before debugging
viewport rendering. Other terminal applications or terminal multiplexers may
intercept or transform mouse events. Do not promise a universal, emulator-
independent fix.

If the wheel scrolls the terminal instead of the chat:

1. Confirm the app is in an open interactive session rather than Home or a
   non-TTY / `CAUSYNE_STAGE=off` fallback.
2. Check `CAUSYNE_MOUSE` is not `0`; check the macOS Terminal.app menu above
   and any tmux/screen mouse forwarding configuration.
3. Inspect actual TTY output for `?1006h` followed by `?1000h`, and actual
   stdin for SGR 64/65 events. Do **not** infer success merely from an internal
   `mouseCaptured` Boolean.
4. If events arrive, verify the decoder, prompt routing, viewport scrollTop,
   and repaint. If no events arrive, do not claim an application-level fix.
5. If the terminal content visibly moves despite Causyne receiving wheel
   events, reproduce on a PTY and inspect rogue writes / Stage lifecycle.

## Regression gates

- `tests/tuiMouseModeOrdering.test.ts`: SGR activation/deactivation ordering
  and wheel decoding.
- `tests/tuiScrollModeStdout.test.ts`: real-process-stdout control writes
  survive `consoleGuard`, and tracking is removed on Home/suspend/exit.
- `tests/mouseScrollIsolation.test.ts`: top/bottom wheel saturation and no
  handoff to terminal scrollback; scroll starts working in the opposite direction
  immediately.
- `tests/tuiScrollInteractionBounds.test.ts`: rail click and wheel geometry.

Before publishing a scrolling fix, run build, strict typecheck, focused tests,
and all CI jobs on macOS, Linux, and Windows. Include a real terminal PTY check
for mode bytes and input events. CI cannot certify the user's host-terminal
mouse-reporting preference.

References:
- https://support.apple.com/guide/terminal/turn-on-mouse-reporting-trmlc69728a5/mac
- https://toppk.github.io/revenant/tdn/input/mouse/
