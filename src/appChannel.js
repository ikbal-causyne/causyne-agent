// The Three-Channel Doctrine, made executable.
//
//   Channel A — the app's own API / plugin / CLI     ~50-200 tok   exact
//   Channel B — the accessibility tree                ~200-800 tok  structured
//   Channel C — pixels: screenshot + OCR + click     ~1,500-2,500  universal, brittle
//
// Channel C costs 10-50x Channel A per observation. An agent that reaches for
// pixels first is not more capable — it is more expensive AND less reliable.
//
// THIS MODULE IS A GUARD, NOT ADVICE. A doctrine that lives only in a system
// prompt is a suggestion the model may ignore on any given turn, and the turn
// it ignores it is the turn it clicks blindly through Blender instead of
// calling `blender_act`. So the router is consulted by `desktop_act` BEFORE any
// actuation, and it refuses the pixel path for an app that has a native one.
//
// It is deliberately NOT a tool the model calls. Another tool schema is another
// ~200 tokens on every request to describe a decision the runtime can make on
// its own, and a decision the model is allowed to skip is not a guard.
//
// EXTENDING IT: a Higgsfield-style plugin (Photoshop UXP, a Blender add-on) is
// one more CHANNEL_A row, not a parallel architecture. That is the whole point
// of the table — the lesson from Higgsfield is "a native app API beats pixels",
// not "build our own Higgsfield".

/**
 * Apps that already have a Channel A tool, keyed by matcher.
 *
 * `match` is tested against a lowercased app name, so "Blender", "blender" and
 * "Blender 4.2" all resolve. Order matters only for readability; the first hit
 * wins.
 */
const CHANNEL_A = [
  { match: /\bblender\b/, tool: 'blender_act', app: 'Blender' },
  { match: /\b(davinci|resolve)\b/, tool: 'resolve_act', app: 'DaVinci Resolve' },
  { match: /\bgodot\b/, tool: 'godot_act', app: 'Godot' },
  { match: /\bpalmier\b/, tool: 'palmier_act', app: 'Palmier Pro' },
  {
    match: /\b(chrome|chromium|safari|firefox|edge|brave|arc)\b/,
    tool: 'browser_act',
    app: 'a web browser'
  }
];

/**
 * Apps a GUI actuator must never drive, because a text interface already
 * exists and driving it by pixels is strictly worse in every dimension —
 * slower, costlier, and unable to read its own output reliably.
 */
const NEVER_BY_PIXEL = [
  { match: /\b(terminal|iterm|iterm2|konsole|gnome-terminal|powershell|cmd|wezterm|alacritty|kitty)\b/,
    tool: 'sysRun',
    reason: 'a shell is a text interface; clicking one is slower and cannot read its output reliably' }
];

/** @typedef {{channel:'A'|'B'|'C', tool:string|null, reason:string, blocked:boolean}} ChannelChoice */

/**
 * Decide the cheapest channel that can drive `appName`.
 *
 * Pure and total — an empty or unknown app name resolves to Channel C, which
 * is correct: "I do not recognise this app" is exactly when the universal
 * fallback is the right answer.
 *
 * @param   {string} appName  Application name, as the user or the OS reports it.
 * @returns {ChannelChoice}
 */
export function resolveChannel(appName) {
  const name = String(appName || '').toLowerCase().trim();

  if (name !== '') {
    for (const entry of NEVER_BY_PIXEL) {
      if (entry.match.test(name)) {
        return {
          channel: 'A',
          tool: entry.tool,
          reason: `${appName} must not be driven by pixels — ${entry.reason}. Use ${entry.tool}.`,
          blocked: true
        };
      }
    }

    for (const entry of CHANNEL_A) {
      if (entry.match.test(name)) {
        return {
          channel: 'A',
          tool: entry.tool,
          reason: `${entry.app} has a native automation API. ${entry.tool} is exact, roughly 10x cheaper `
            + `per observation, and does not break when the window moves. Use it instead of clicking.`,
          blocked: true
        };
      }
    }
  }

  return {
    channel: 'C',
    tool: null,
    reason: name === ''
      ? 'No application named, so no native channel can be selected; the pixel path applies.'
      : `No native automation channel is registered for "${appName}". Read it with ax_snapshot first `
        + `(Channel B, structured and ~5x cheaper than a screenshot), and act by element name where possible.`,
    blocked: false
  };
}

/** Every app name pattern with a Channel A tool. For tests and diagnostics. */
export function channelATools() {
  return [...CHANNEL_A.map(e => e.tool), ...NEVER_BY_PIXEL.map(e => e.tool)];
}
